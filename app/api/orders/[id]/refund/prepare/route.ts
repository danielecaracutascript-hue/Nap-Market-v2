import { recordedSubmission, SubmissionCoordinationError } from "@/lib/escrow-submission";
import { broadcastReceipt, recordedBroadcast } from "@/lib/escrow-settlement";
import { legacyEscrowKeys } from "@/lib/escrow-legacy-policy";
import { legacyPreparationInputs } from "@/lib/escrow-preparation";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rpc } from "@/lib/bitcoin";
import { buildRefundPsbt, payoutAddress, refundAmounts, refundKindFromEvents } from "@/lib/escrow";
import { isLegacyEscrowProtocol } from "@/lib/escrow-protocol";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const { data: o, error: orderError } = await supabase
      .from("orders")
      .select("id, status, buyer_id, escrow_protocol, price_sats, buyer_commission_sats, seller_commission_sats, escrow_index, escrow_descriptor, funding_txid, funding_vout, refunded_txid")
      .eq("id", id)
      .maybeSingle();
    if (orderError) return NextResponse.json({ error: "Order details are temporarily unavailable. No new transaction was sent." }, { status: 503 });
    if (!o || o.buyer_id !== auth.user.id) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    if (!isLegacyEscrowProtocol(o.escrow_protocol)) {
      return NextResponse.json({ error: "Escrow V2 refund is not enabled" }, { status: 409 });
    }
    if (o.status !== "REFUNDED") return NextResponse.json({ error: "The order is not refunded" }, { status: 400 });
    if (o.refunded_txid) return NextResponse.json(broadcastReceipt(o.refunded_txid, false, true));
    if (!o.funding_txid || o.funding_vout === null || !o.escrow_descriptor) {
      return NextResponse.json({ error: "The order has no confirmed payment" }, { status: 400 });
    }

    const admin = createAdminClient();
    const previousTxid = await recordedBroadcast(admin, id, "refund");
    if (previousTxid) {
      return NextResponse.json(broadcastReceipt(previousTxid, true, true), { status: 202 });
    }
    const existingSubmission = await recordedSubmission(admin, id);
    if (existingSubmission) return NextResponse.json(existingSubmission, { status: 202 });
    const { data: existing, error: existingError } = await admin
      .from("psbts")
      .select("id, psbt")
      .eq("order_id", id)
      .eq("purpose", "refund")
      .in("status", ["draft", "partial"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingError) throw new Error("Could not read the prepared transaction. No new transaction was sent.");
    if (existing) return NextResponse.json({ id: existing.id, psbt: existing.psbt });

    const { data: evs, error: eventError } = await admin.from("order_events").select("type, data").eq("order_id", id);
    if (eventError) return NextResponse.json({ error: "Refund history is temporarily unavailable. No new transaction was sent." }, { status: 503 });
    const kind = refundKindFromEvents(evs ?? []);
    if (!kind) return NextResponse.json({ error: "No refund reason is recorded for this order" }, { status: 400 });

    const { buyerXpub: bx, platformXpub: px } = legacyEscrowKeys(o.escrow_descriptor);

    const inputs = legacyPreparationInputs(o, process.env.RELEASE_FEE_SATS ?? 700);
    if (!inputs.ok) return NextResponse.json({ error: inputs.message }, { status: inputs.status });
    const { index: idx, fee } = inputs;
    const { escrowTotal, platform } = refundAmounts(o, kind);
    const buyerAmount = escrowTotal - platform - fee;
    if (buyerAmount < 1000) return NextResponse.json({ error: "The amount is too small to refund" }, { status: 400 });

    const txHex = (await rpc<{ hex: string }>("gettransaction", [o.funding_txid], "escrow1")).hex;
    const psbt = await buildRefundPsbt({
      descriptor: o.escrow_descriptor,
      index: idx,
      txHex,
      vout: Number(o.funding_vout),
      buyerXpub: bx,
      platformXpub: px,
      buyerAddress: await payoutAddress(bx, 3, idx),
      platformAddress: await payoutAddress(px, 3, idx),
      buyerAmount,
      platformAmount: platform,
    });

    const { data: row, error } = await admin
      .from("psbts")
      .insert({ order_id: id, purpose: "refund", psbt, signed_by: [], status: "draft" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ id: row.id, psbt });
  } catch (e) {
    if (e instanceof SubmissionCoordinationError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
