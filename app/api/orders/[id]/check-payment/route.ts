import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rpc } from "@/lib/bitcoin";
import { testChainForNetwork } from "@/lib/bitcoin-test-network";
import { isLegacyEscrowProtocol } from "@/lib/escrow-protocol";

type Utxo = { txid: string; vout: number; amount: number; confirmations: number };

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const { data: o, error: orderError } = await supabase
      .from("orders")
      .select("id, buyer_id, seller_id, status, escrow_protocol, price_sats, buyer_commission_sats, shipping_sats, escrow_descriptor, escrow_index, escrow_address, shipping_address, expires_at")
      .eq("id", id)
      .maybeSingle();
    if (orderError) return NextResponse.json({ error: "Order details are temporarily unavailable. Do not send another payment until the status is clear." }, { status: 503 });
    if (!o || (o.buyer_id !== auth.user.id && o.seller_id !== auth.user.id)) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    if (!isLegacyEscrowProtocol(o.escrow_protocol)) {
      return NextResponse.json({ error: "Escrow V2 funding checks are not enabled" }, { status: 409 });
    }
    if (o.status !== "CREATED") {
      return NextResponse.json({ ok: true, message: "Order status: " + o.status });
    }
    if (!o.escrow_address || !o.shipping_address) {
      return NextResponse.json({ error: "Payment details have not been created yet" }, { status: 400 });
    }

    const price = Number(o.price_sats);
    const buyerFee = Number(o.buyer_commission_sats);
    const shipping = Number(o.shipping_sats);
    const needEscrow = price + buyerFee;
    if (o.price_sats == null || o.buyer_commission_sats == null || o.shipping_sats == null ||
        !Number.isSafeInteger(price) || price <= 0 ||
        !Number.isSafeInteger(buyerFee) || buyerFee < 0 ||
        !Number.isSafeInteger(shipping) || shipping < 0 ||
        !Number.isSafeInteger(needEscrow)) {
      return NextResponse.json({ error: "Invalid order amounts" }, { status: 400 });
    }
    const chain = testChainForNetwork(process.env.NEXT_PUBLIC_BITCOIN_NETWORK ?? "testnet");
    if (!chain) return NextResponse.json({ error: "Payment checks require a supported test network" }, { status: 503 });
    const node = await rpc<{ chain: string }>("getblockchaininfo");
    if (node?.chain !== chain) {
      return NextResponse.json({ error: "The node network does not match the app configuration" }, { status: 503 });
    }
    const utxos = await rpc<Utxo[]>("listunspent", [1, 9999999, [o.escrow_address]], "escrow1");
    if (!utxos || !Array.isArray(utxos)) {
      return NextResponse.json({ ok: true, message: "Escrow payment not confirmed yet" });
    }
    // Legacy spending supports one input with exactly the agreed amount.
    // Keep actual excess/split payments visible without recording unusable funding.
    const amounts = utxos.map((x) => Math.round(x.amount * 1e8));
    if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount <= 0)) {
      return NextResponse.json({ error: "Invalid payment amounts returned by the node" }, { status: 502 });
    }
    const receivedEscrowSats = amounts.reduce((sum, amount) => sum + amount, 0);
    if (!Number.isSafeInteger(receivedEscrowSats)) {
      return NextResponse.json({ error: "Invalid total payment amount" }, { status: 502 });
    }
    if (receivedEscrowSats >= needEscrow &&
        (utxos.length !== 1 || amounts[0] !== needEscrow)) {
      return NextResponse.json({
        ok: true,
        requiresReview: true,
        receivedEscrowSats,
        expectedEscrowSats: needEscrow,
        message: "An escrow payment was detected, but its amount or multiple outputs require manual review. The order has not been marked as funded. Do not send another payment.",
      });
    }
    const u = utxos.length === 1 && amounts[0] === needEscrow ? utxos[0] : undefined;
    const received = await rpc<number>("getreceivedbyaddress", [o.shipping_address, 1], "shipping");
    const gotShipping = Math.round(received * 1e8);
    if (!Number.isSafeInteger(gotShipping) || gotShipping < 0) {
      return NextResponse.json({ error: "Invalid shipping payment amount returned by the node" }, { status: 502 });
    }

    if (!u) return NextResponse.json({ ok: true, message: "Escrow payment not confirmed yet" });
    if (gotShipping < Number(o.shipping_sats)) {
      return NextResponse.json({ ok: true, message: "Escrow paid. Shipping payment not confirmed yet" });
    }
    const expiresAt = new Date(o.expires_at).getTime();
    if (!Number.isFinite(expiresAt)) {
      return NextResponse.json({ error: "Invalid order expiration" }, { status: 400 });
    }
    if (expiresAt <= Date.now()) {
      return NextResponse.json({ ok: true, message: "The order expired before the payment was confirmed. Late payments need manual review." });
    }

    const tip = await rpc<number>("getblockcount");
    const height = tip - u.confirmations + 1;
    if (!/^[0-9a-f]{64}$/.test(u.txid) || !Number.isSafeInteger(u.vout) || u.vout < 0 ||
        !Number.isSafeInteger(u.confirmations) || u.confirmations < 1 ||
        !Number.isSafeInteger(tip) || tip < 0 || !Number.isSafeInteger(height) || height < 0) {
      return NextResponse.json({ error: "Invalid funding details returned by the node" }, { status: 502 });
    }
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("confirm_order_funding_snapshot", {
      p_order: id,
      p_actor: auth.user.id,
      p_txid: u.txid,
      p_vout: u.vout,
      p_height: height,
      p_escrow_sats: needEscrow,
      p_shipping_sats: gotShipping,
      p_expected: {
        buyer_id: o.buyer_id, seller_id: o.seller_id,
        price_sats: String(o.price_sats), buyer_commission_sats: String(o.buyer_commission_sats),
        shipping_sats: String(o.shipping_sats), escrow_descriptor: o.escrow_descriptor,
        escrow_index: o.escrow_index == null ? null : String(o.escrow_index),
        escrow_address: o.escrow_address, shipping_address: o.shipping_address, expires_at: o.expires_at,
      },
    });
    if (error || data?.ok !== true) {
      return NextResponse.json({
        requiresReview: true,
        message: "A payment was detected, but its registration could not be confirmed. Refresh and check again. Do not send another payment.",
      }, { status: 503 });
    }
    return NextResponse.json({ ok: true, message: "Payment confirmed" });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
