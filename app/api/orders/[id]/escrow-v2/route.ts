import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rpc } from "@/lib/bitcoin";
import { testChainForNetwork } from "@/lib/bitcoin-test-network";
import { candidateEscrowDescriptor, type EscrowParticipants } from "@/lib/escrow-v2";
import { deriveEscrowV2WitnessScript } from "@/lib/escrow-v2-script";

type DescriptorInfo = { descriptor: string; issolvable: boolean; hasprivatekeys: boolean };

/**
 * Dedicated, server-only V2 creation path. It is deliberately disabled by
 * default and is not called by checkout until V2 settlement is complete.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (process.env.ESCROW_V2_ENABLED !== "true") {
    return NextResponse.json({ error: "Escrow V2 is not enabled" }, { status: 503 });
  }
  const { id } = await params;
  try {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const { data: order, error: orderError } = await supabase.from("orders")
      .select("id, buyer_id, seller_id, status, escrow_protocol, escrow_index, escrow_address, expires_at")
      .eq("id", id).maybeSingle();
    if (orderError) return NextResponse.json({ error: "Order details are temporarily unavailable" }, { status: 503 });
    if (!order || order.buyer_id !== auth.user.id) return NextResponse.json({ error: "Order not found" }, { status: 404 });
    if (order.status !== "CREATED" || order.escrow_protocol !== "escrow_v2") {
      return NextResponse.json({ error: "Order is not available for Escrow V2" }, { status: 409 });
    }
    if (order.escrow_address) return NextResponse.json({ ok: true, message: "Escrow V2 payment details already created" });
    const index = order.escrow_index;
    if (!Number.isSafeInteger(index) || index < 0 || index > 10000 || !order.expires_at || new Date(order.expires_at).getTime() <= Date.now()) {
      return NextResponse.json({ error: "Order expiration or escrow index requires review" }, { status: 409 });
    }
    const admin = createAdminClient();
    const { data: profiles, error: profilesError } = await admin.from("profiles").select("id, wallet_xpub").in("id", [order.buyer_id, order.seller_id]);
    if (profilesError) return NextResponse.json({ error: "Wallet public keys are temporarily unavailable" }, { status: 503 });
    const participants: EscrowParticipants = {
      buyerXpub: profiles?.find((profile) => profile.id === order.buyer_id)?.wallet_xpub ?? "",
      sellerXpub: profiles?.find((profile) => profile.id === order.seller_id)?.wallet_xpub ?? "",
      platformEscrowXpub: process.env.PLATFORM_XPUB ?? "",
    };
    const descriptor = candidateEscrowDescriptor(participants, index);
    const witnessScript = deriveEscrowV2WitnessScript(participants, index);
    const chain = testChainForNetwork(process.env.NEXT_PUBLIC_BITCOIN_NETWORK ?? "testnet");
    if (!chain || (await rpc<{ chain: string }>("getblockchaininfo")).chain !== chain) {
      return NextResponse.json({ error: "Escrow V2 requires the configured test network" }, { status: 503 });
    }
    const info = await rpc<DescriptorInfo>("getdescriptorinfo", [descriptor]);
    if (!info.issolvable || info.hasprivatekeys || !info.descriptor) throw new Error("Invalid public Escrow V2 descriptor");
    const addresses = await rpc<string[]>("deriveaddresses", [info.descriptor]);
    if (addresses.length !== 1 || !addresses[0]) throw new Error("Could not derive the Escrow V2 address");
    const imported = await rpc<{ success: boolean }[]>("importdescriptors", [[{ desc: info.descriptor, timestamp: "now" }]], "escrow1");
    if (!imported[0]?.success) throw new Error("Escrow V2 watch import failed");
    const shippingAddress = await rpc<string>("getnewaddress", ["order-" + id.slice(0, 8)], "shipping");
    const { data, error } = await admin.rpc("set_order_escrow_v2_snapshot", {
      p_order: id, p_actor: auth.user.id, p_descriptor: info.descriptor, p_address: addresses[0], p_shipping_address: shippingAddress,
      p_participants: { buyer_xpub: participants.buyerXpub, seller_xpub: participants.sellerXpub, platform_escrow_xpub: participants.platformEscrowXpub },
      p_witness_script: Buffer.from(witnessScript).toString("hex"),
      p_expected: { buyer_id: order.buyer_id, seller_id: order.seller_id, escrow_index: String(index), expires_at: order.expires_at },
    });
    if (error || data?.ok !== true) return NextResponse.json({ error: "Escrow V2 details could not be confirmed" }, { status: 503 });
    return NextResponse.json({ ok: true, message: data.alreadyCreated ? "Escrow V2 payment details already created" : "Escrow V2 payment details created" });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
