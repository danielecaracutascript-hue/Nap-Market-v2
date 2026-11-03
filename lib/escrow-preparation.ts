/** Validate public order metadata before creating a new legacy draft. */
function integer(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

export function legacyPreparationInputs(order: {
  price_sats: unknown; buyer_commission_sats: unknown; seller_commission_sats: unknown;
  escrow_index: unknown; funding_txid: unknown; funding_vout: unknown;
}, configuredFee: unknown):
  | { ok: true; index: number; fee: number }
  | { ok: false; status: number; message: string } {
  const fee = integer(configuredFee);
  if (fee === null || fee > 5000) {
    return { ok: false, status: 503, message: "The network fee configuration must be an integer from 0 to 5000 sat. No new transaction was prepared." };
  }
  const price = integer(order.price_sats), buyerFee = integer(order.buyer_commission_sats);
  const sellerFee = integer(order.seller_commission_sats), index = integer(order.escrow_index);
  const vout = integer(order.funding_vout);
  if (price === null || price === 0 || buyerFee === null || sellerFee === null ||
      !Number.isSafeInteger(price + buyerFee) || !Number.isSafeInteger(buyerFee + sellerFee) ||
      index === null || index >= 0x80000000 || vout === null || vout > 0xffffffff ||
      typeof order.funding_txid !== "string" || !/^[0-9a-fA-F]{64}$/.test(order.funding_txid)) {
    return { ok: false, status: 409, message: "The order amounts or original funding metadata require manual review. No new transaction was prepared." };
  }
  return { ok: true, index, fee };
}
