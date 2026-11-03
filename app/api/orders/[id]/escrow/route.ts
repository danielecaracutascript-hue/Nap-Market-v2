import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rpc } from "@/lib/bitcoin";
import { legacyEscrowKeys } from "@/lib/escrow-legacy-policy";
import { testChainForNetwork } from "@/lib/bitcoin-test-network";
import { isLegacyEscrowProtocol } from "@/lib/escrow-protocol";

const T1 = Number(process.env.ESCROW_CONCORDATA_BLOCKS ?? 5);
const T2 = Number(process.env.ESCROW_BUYER_TIMELOCK_BLOCKS ?? 10);

type Info = { descriptor: string; issolvable: boolean };

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("id, buyer_id, seller_id, status, escrow_protocol, escrow_index, escrow_address, expires_at")
      .eq("id", id)
      .maybeSingle();
    if (orderError) return NextResponse.json({ error: "Order details are temporarily unavailable" }, { status: 503 });
    if (!order || order.buyer_id !== auth.user.id) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    if (!isLegacyEscrowProtocol(order.escrow_protocol)) {
      return NextResponse.json({ error: "Escrow V2 is not enabled for payment creation" }, { status: 409 });
    }
    if (order.status !== "CREATED") {
      return NextResponse.json({ error: "Order is not waiting for payment" }, { status: 400 });
    }
    if (order.escrow_address) {
      return NextResponse.json({ ok: true, message: "Payment details already created" });
    }
    const expiresAt = order.expires_at ? new Date(order.expires_at).getTime() : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return NextResponse.json({ error: "The order is expired or its expiration needs review" }, { status: 409 });
    }
    const idx = order.escrow_index;
    if (!Number.isSafeInteger(idx) || idx < 0 || idx > 10000) {
      return NextResponse.json({ error: "The escrow index is outside the supported watch range; manual review required" }, { status: 409 });
    }
    if (![T1, T2].every((delay) => Number.isSafeInteger(delay) && delay > 0 && delay <= 65535)) {
      return NextResponse.json({ error: "Invalid escrow block-delay configuration" }, { status: 503 });
    }

    // Full profiles are owner-only. The verified order buyer may request the
    // two participants' public keys through this server-only client.
    const admin = createAdminClient();
    const { data: profs, error: profileError } = await admin
      .from("profiles")
      .select("id, wallet_xpub")
      .in("id", [order.buyer_id, order.seller_id]);
    if (profileError) return NextResponse.json({ error: "Wallet public keys are temporarily unavailable" }, { status: 503 });
    const bx = profs?.find((p) => p.id === order.buyer_id)?.wallet_xpub;
    const sx = profs?.find((p) => p.id === order.seller_id)?.wallet_xpub;
    const px = process.env.PLATFORM_XPUB;
    if (!bx || !sx) {
      return NextResponse.json({ error: "Buyer and seller both need a wallet public key in their profile" }, { status: 400 });
    }
    if (!px) return NextResponse.json({ error: "Platform key is not configured" }, { status: 500 });

    const k = (x: string, b: number) => `${x}/${b}/*`;
    const desc =
      `wsh(or_i(and_v(v:pk(${k(px, 0)}),or_d(pk(${k(bx, 0)}),pk(${k(sx, 0)}))),` +
      `or_i(and_v(v:multi(2,${k(bx, 2)},${k(sx, 2)}),older(${T1})),` +
      `and_v(v:pk(${k(bx, 1)}),older(${T2})))))`;

    // Validate the entire known public-key policy before sending profile data
    // to Core. This also rejects injected descriptor syntax and private keys.
    try {
      const keys = legacyEscrowKeys(desc);
      const bareKeys = Object.values(keys).map((key) => key.replace(/^\[[^\]]*\]/, ""));
      if (new Set(bareKeys).size !== 3) throw new Error("Duplicate escrow participants");
    } catch {
      return NextResponse.json({ error: "Escrow requires three distinct valid public-key expressions; manual review required" }, { status: 400 });
    }

    const chain = testChainForNetwork(process.env.NEXT_PUBLIC_BITCOIN_NETWORK ?? "testnet");
    if (!chain) return NextResponse.json({ error: "Escrow creation requires a supported test network" }, { status: 503 });
    const node = await rpc<{ chain: string }>("getblockchaininfo");
    if (node?.chain !== chain) {
      return NextResponse.json({ error: "The node network does not match the app configuration" }, { status: 503 });
    }
    const info = await rpc<Info>("getdescriptorinfo", [desc]);
    if (!info?.issolvable || typeof info.descriptor !== "string") throw new Error("The escrow script is not solvable");
    const addrs = await rpc<string[]>("deriveaddresses", [info.descriptor, [idx, idx]]);
    if (!Array.isArray(addrs) || addrs.length !== 1 || typeof addrs[0] !== "string" || !addrs[0]) {
      throw new Error("The node did not return a single escrow address");
    }
    const escrowAddress = addrs[0];

    const imp = await rpc<{ success: boolean; error?: { message: string } }[]>(
      "importdescriptors",
      [[{ desc: info.descriptor, timestamp: "now", range: [0, 10000] }]],
      "escrow1"
    );
    if (!imp[0]?.success) throw new Error("Watch import failed: " + (imp[0]?.error?.message ?? "unknown"));

    const shipAddress = await rpc<string>("getnewaddress", ["order-" + id.slice(0, 8)], "shipping");
    if (typeof shipAddress !== "string" || !shipAddress) throw new Error("The node did not return a shipping address");

    const { data, error } = await admin.rpc("set_order_escrow_snapshot", {
      p_order: id,
      p_actor: auth.user.id,
      p_descriptor: info.descriptor,
      p_address: escrowAddress,
      p_shipping_address: shipAddress,
      p_expected: {
        buyer_id: order.buyer_id, seller_id: order.seller_id,
        escrow_index: String(idx), expires_at: order.expires_at,
      },
    });
    if (error || data?.ok !== true) {
      return NextResponse.json({ error: "Payment details could not be confirmed. Refresh the order before making a payment." }, { status: 503 });
    }
    return NextResponse.json({ ok: true, message: data.alreadyCreated ? "Payment details already created. Use the details stored on the order." : "Payment details created" });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
