import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyReservedSettlement, type ReconciliationOrder, type ReconciliationClaim } from "@/lib/escrow-reconciliation";
import { refundKindFromEvents } from "@/lib/escrow";
import { broadcastReceipt, settlementSnapshot } from "@/lib/escrow-settlement";
import { pendingSubmissionReceipt } from "@/lib/escrow-submission";
import { isLegacyEscrowProtocol } from "@/lib/escrow-protocol";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const { data: order, error: orderError } = await supabase.from("orders")
      .select("id, buyer_id, seller_id, status, escrow_protocol, price_sats, buyer_commission_sats, seller_commission_sats, escrow_index, escrow_descriptor, escrow_address, funding_txid, funding_vout, released_txid, refunded_txid")
      .eq("id", id).maybeSingle();
    if (orderError) throw new Error("Could not read the order.");
    if (!order || (order.buyer_id !== auth.user.id && order.seller_id !== auth.user.id)) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    if (!isLegacyEscrowProtocol(order.escrow_protocol)) {
      return NextResponse.json({ error: "Escrow V2 settlement reconciliation is not enabled" }, { status: 409 });
    }
    const admin = createAdminClient();
    const { data: claim, error: claimError } = await admin.from("escrow_submission_claims")
      .select("order_id, purpose, txid, funding_txid, funding_vout, psbt_id, claim_id, state")
      .eq("order_id", id).maybeSingle();
    if (claimError) throw new Error("Submission records are unavailable.");
    if (!claim) return NextResponse.json({ error: "No reserved submission was found. No order was changed." }, { status: 404 });
    const { data: draft, error: draftError } = await admin.from("psbts")
      .select("id, order_id, purpose, psbt").eq("id", claim.psbt_id).eq("order_id", id).maybeSingle();
    if (draftError || !draft || draft.purpose !== claim.purpose) throw new Error("The reserved transaction needs review.");
    let refundKind = null;
    if (claim.purpose === "refund") {
      const { data: events, error } = await admin.from("order_events").select("type, data").eq("order_id", id);
      if (error) throw new Error("The refund history could not be verified.");
      refundKind = refundKindFromEvents(events ?? []);
    }
    const proof = await verifyReservedSettlement({ order: order as ReconciliationOrder,
      claim: claim as ReconciliationClaim, psbtBase64: draft.psbt,
      network: process.env.NEXT_PUBLIC_BITCOIN_NETWORK ?? "testnet", refundKind });
    if (!proof.verified) {
      return NextResponse.json({ ...pendingSubmissionReceipt(claim.txid), message: proof.reason }, { status: 202 });
    }
    // Atomic and idempotent. Does not send, replace or unlock a transaction.
    try {
      const { data, error } = await admin.rpc("reconcile_escrow_submission", {
        p_order: id, p_claim_id: claim.claim_id, p_txid: claim.txid,
        p_expected: settlementSnapshot(order, draft.psbt), p_confirmed: true,
      });
      if (error || data?.ok !== true || data.txid !== claim.txid || data.reconciled !== true || data.confirmed !== true) {
        return NextResponse.json(broadcastReceipt(claim.txid, true, true), { status: 202 });
      }
    } catch {
      return NextResponse.json(broadcastReceipt(claim.txid, true, true), { status: 202 });
    }
    return NextResponse.json({ ...broadcastReceipt(claim.txid, false, true),
      confirmations: proof.confirmations, blockhash: proof.blockhash });
  } catch {
    return NextResponse.json({ error: "Transaction status could not be verified. No new transaction was sent; any reservation remains blocked." }, { status: 503 });
  }
}
