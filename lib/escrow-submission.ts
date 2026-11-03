import "server-only";
import { randomUUID } from "node:crypto";
import { Transaction } from "bitcoinjs-lib";
import type { SupabaseClient } from "@supabase/supabase-js";
import { broadcastReceipt } from "./escrow-settlement";

type SubmissionState = "pending" | "broadcast" | "reconciled";
type Submission = { txid: string; state: SubmissionState };

export class SubmissionCoordinationError extends Error {
  constructor() {
    super("Transaction submission is temporarily unavailable. No new transaction was sent.");
  }
}

export function pendingSubmissionReceipt(txid: string) {
  return {
    ok: true,
    broadcast: false,
    submissionPending: true,
    reconciliationRequired: true,
    txid,
    message: "A transaction submission is reserved or its outcome is uncertain. Do not submit another transaction. Its status needs review.",
  };
}

function parseSubmission(value: unknown): Submission {
  const record = value as Partial<Submission> | null;
  if (!record || typeof record.txid !== "string" || !/^[0-9a-f]{64}$/.test(record.txid) ||
      !["pending", "broadcast", "reconciled"].includes(record.state ?? "")) {
    throw new SubmissionCoordinationError();
  }
  return { txid: record.txid, state: record.state! };
}

function submissionReceipt(submission: Submission) {
  return submission.state === "pending"
    ? pendingSubmissionReceipt(submission.txid)
    : broadcastReceipt(submission.txid, submission.state !== "reconciled", true);
}

/** Fails closed if the database migration is missing or its result is unreadable. */
export async function recordedSubmission(admin: SupabaseClient, orderId: string) {
  const { data, error } = await admin.from("escrow_submission_claims")
    .select("txid, state").eq("order_id", orderId).maybeSingle();
  if (error) throw new SubmissionCoordinationError();
  return data ? submissionReceipt(parseSubmission(data)) : null;
}

/** Persist the exact candidate TXID before the first and only transmission attempt. */
export async function claimSubmission(admin: SupabaseClient, args: {
  orderId: string;
  purpose: "release" | "refund";
  txHex: string;
  fundingTxid: string;
  fundingVout: number;
  psbtId: string;
}) {
  const txid = Transaction.fromHex(args.txHex).getId();
  const claimId = randomUUID();
  const { data, error } = await admin.rpc("claim_escrow_submission", {
    p_order: args.orderId, p_purpose: args.purpose, p_txid: txid,
    p_funding_txid: args.fundingTxid.toLowerCase(), p_funding_vout: args.fundingVout,
    p_psbt_id: args.psbtId, p_claim_id: claimId,
  });
  if (error) throw new SubmissionCoordinationError();
  const submission = parseSubmission(data);
  if (data.order_id !== args.orderId || typeof data.acquired !== "boolean") {
    throw new SubmissionCoordinationError();
  }
  if (data.acquired && (data.txid !== txid || data.claim_id !== claimId ||
      data.purpose !== args.purpose || data.state !== "pending")) {
    throw new SubmissionCoordinationError();
  }
  return { acquired: data.acquired as boolean, txid: submission.txid, claimId,
    receipt: submissionReceipt(submission) };
}

/** Update only this claim; a failed write must never turn a known send into failure. */
export async function saveSubmissionState(
  admin: SupabaseClient, orderId: string, claimId: string, txid: string,
  state: "broadcast" | "reconciled",
): Promise<boolean> {
  try {
    const { data, error } = await admin.from("escrow_submission_claims")
      .update({ state, acknowledged_at: new Date().toISOString() })
      .eq("order_id", orderId).eq("claim_id", claimId).eq("txid", txid)
      .in("state", state === "broadcast" ? ["pending"] : ["pending", "broadcast"])
      .select("order_id").maybeSingle();
    return !error && !!data;
  } catch { return false; }
}
