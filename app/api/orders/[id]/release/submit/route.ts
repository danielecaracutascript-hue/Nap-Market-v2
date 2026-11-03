import { recordedSubmission, SubmissionCoordinationError, claimSubmission, saveSubmissionState, pendingSubmissionReceipt } from "@/lib/escrow-submission";
import { broadcastReceipt, recordedBroadcast, settlementSnapshot } from "@/lib/escrow-settlement";
import { legacyEscrowKeys } from "@/lib/escrow-legacy-policy";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rpc } from "@/lib/bitcoin";
import {
  derivePubkey,
  hexOf,
  payoutAddress,
  releaseAmounts,
  sigPubkeys,
  signWith,
  txFingerprint,
  verifyReleasePsbt,
} from "@/lib/escrow";
import { isLegacyEscrowProtocol } from "@/lib/escrow-protocol";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let acknowledgedTxid: string | null = null;
  let reservedTxid: string | null = null;
  try {
    const body = await req.json();
    const signed = String(body.psbt ?? "");
    if (!signed) return NextResponse.json({ error: "Missing transaction" }, { status: 400 });

    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const { data: o, error: orderError } = await supabase
      .from("orders")
      .select("id, status, seller_id, escrow_protocol, price_sats, buyer_commission_sats, seller_commission_sats, escrow_index, escrow_descriptor, escrow_address, funding_txid, funding_vout, released_txid")
      .eq("id", id)
      .maybeSingle();
    if (orderError) return NextResponse.json({ error: "Order details are temporarily unavailable. No new transaction was sent." }, { status: 503 });
    if (!o || o.seller_id !== auth.user.id) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    if (!isLegacyEscrowProtocol(o.escrow_protocol)) {
      return NextResponse.json({ error: "Escrow V2 release is not enabled" }, { status: 409 });
    }

    // --- Regola della piattaforma: firma solo se tutto torna ---
    if (o.released_txid) return NextResponse.json(broadcastReceipt(o.released_txid, false, true));
    if (o.status !== "COMPLETED") {
      return NextResponse.json({ error: "Platform policy: the order is not releasable" }, { status: 400 });
    }
    const admin = createAdminClient();
    const previousTxid = await recordedBroadcast(admin, id, "release");
    if (previousTxid) {
      return NextResponse.json(broadcastReceipt(previousTxid, true, true), { status: 202 });
    }
    const existingSubmission = await recordedSubmission(admin, id);
    if (existingSubmission) return NextResponse.json(existingSubmission, { status: 202 });
    const { data: draft, error: draftError } = await admin
      .from("psbts")
      .select("id, psbt")
      .eq("order_id", id)
      .eq("purpose", "release")
      .in("status", ["draft", "partial"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (draftError) throw new Error("Could not read the prepared transaction. No new transaction was sent.");
    if (!draft) return NextResponse.json({ error: "No release transaction was prepared" }, { status: 400 });
    if ((await txFingerprint(draft.psbt)) !== (await txFingerprint(signed))) {
      return NextResponse.json({ error: "Platform policy: this is not the transaction that was prepared" }, { status: 400 });
    }

    const { sellerXpub: sx, platformXpub: px } = legacyEscrowKeys(o.escrow_descriptor);

    const idx = Number(o.escrow_index);
    const { escrowTotal, platform } = releaseAmounts(o);
    const check = await verifyReleasePsbt({
      psbtBase64: signed,
      fundingTxid: o.funding_txid as string,
      fundingVout: Number(o.funding_vout),
      escrowTotal,
      platformAmount: platform,
      sellerAddress: await payoutAddress(sx, 3, idx),
      platformAddress: await payoutAddress(px, 3, idx),
      maxFee: 5000,
    });
    if (!check.ok) {
      return NextResponse.json({ error: "Platform policy refused to sign: " + check.reason }, { status: 400 });
    }

    // --- Firma della piattaforma ---
    const mnemonic = process.env.PLATFORM_MNEMONIC;
    if (!mnemonic) return NextResponse.json({ error: "Platform signing key is not configured" }, { status: 500 });
    const sellerPub = await derivePubkey(sx, 0, idx);
    const platformPub = await derivePubkey(px, 0, idx);
    const both = await signWith({ mnemonic, psbtBase64: signed, keepPubkeys: [sellerPub, platformPub] });
    const have = await sigPubkeys(both);
    if (!have.includes(hexOf(sellerPub)) || !have.includes(hexOf(platformPub))) {
      return NextResponse.json({ error: "A signature is missing" }, { status: 400 });
    }

    // --- Completamento con Bitcoin Core e invio alla rete ---
    const done = await rpc<{ complete: boolean; hex?: string }>("descriptorprocesspsbt", [
      both,
      [{ desc: o.escrow_descriptor, range: [idx, idx] }],
    ]);
    if (!done.complete || !done.hex) {
      return NextResponse.json({ error: "The transaction could not be completed" }, { status: 400 });
    }
    const submission = await claimSubmission(admin, {
      orderId: id, purpose: "release", txHex: done.hex,
      fundingTxid: o.funding_txid as string, fundingVout: Number(o.funding_vout),
      psbtId: String(draft.id),
    });
    if (!submission.acquired) return NextResponse.json(submission.receipt, { status: 202 });
    reservedTxid = submission.txid;

    const returnedTxid = await rpc<string>("sendrawtransaction", [done.hex]);
    if (returnedTxid.toLowerCase() !== submission.txid) {
      throw new Error("Node acknowledgment does not match the reserved transaction");
    }
    const txid = submission.txid;
    acknowledgedTxid = txid;
    await saveSubmissionState(admin, id, submission.claimId, txid, "broadcast");

    const { data: recorded, error: recordError } = await admin.rpc("reconcile_escrow_submission", {
      p_order: id, p_claim_id: submission.claimId, p_txid: txid,
      p_expected: settlementSnapshot(o, draft.psbt), p_confirmed: false, p_psbt: both,
    });
    if (recordError || recorded?.ok !== true || recorded.txid !== txid || recorded.reconciled !== true) {
      return NextResponse.json(broadcastReceipt(txid, true), { status: 202 });
    }
    return NextResponse.json(broadcastReceipt(txid, false));
  } catch (e) {
    if (acknowledgedTxid) {
      return NextResponse.json(broadcastReceipt(acknowledgedTxid, true), { status: 202 });
    }
    if (reservedTxid) {
      return NextResponse.json(pendingSubmissionReceipt(reservedTxid), { status: 202 });
    }
    if (e instanceof SubmissionCoordinationError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
