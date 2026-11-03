export type BroadcastReceipt = {
  broadcast: true;
  txid: string;
  reconciliationRequired: boolean;
} | {
  broadcast: false;
  submissionPending: true;
  txid: string;
  reconciliationRequired: true;
};

export function readBroadcastReceipt(value: unknown): BroadcastReceipt | null {
  if (!value || typeof value !== "object") return null;
  const receipt = value as { broadcast?: unknown; txid?: unknown; reconciliationRequired?: unknown; submissionPending?: unknown };
  if (typeof receipt.txid !== "string" ||
      !/^[0-9a-fA-F]{64}$/.test(receipt.txid) ||
      typeof receipt.reconciliationRequired !== "boolean") return null;
  if (receipt.broadcast === true) {
    return { broadcast: true, txid: receipt.txid, reconciliationRequired: receipt.reconciliationRequired };
  }
  if (receipt.broadcast === false && receipt.submissionPending === true && receipt.reconciliationRequired === true) {
    return { broadcast: false, submissionPending: true, txid: receipt.txid, reconciliationRequired: true };
  }
  return null;
}

export const receiptStorageKey = (userId: string, orderId: string) =>
  `escrow-broadcast:${userId}:${orderId}`;

export function receiptMessage(receipt: BroadcastReceipt): string {
  if (!receipt.broadcast) {
    return "A transaction submission is reserved or its outcome is uncertain. Do not submit another transaction. Its status needs review. Transaction " + receipt.txid;
  }
  return (receipt.reconciliationRequired
    ? "The transaction was sent. Order synchronization needs review. Do not submit another transaction."
    : "The transaction was sent and recorded.") + " Transaction " + receipt.txid;
}
