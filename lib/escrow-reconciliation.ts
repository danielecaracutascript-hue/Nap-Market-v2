import "server-only";
import * as bitcoin from "bitcoinjs-lib";
import * as descriptors from "@bitcoinerlab/descriptors";
import { rpc } from "./bitcoin";
import { legacyEscrowKeys } from "./escrow-legacy-policy";

type ReadMethod = "getblockchaininfo" | "gettransaction" | "getrawtransaction" | "getblockheader" | "getblockhash";
export type ReconciliationReadRpc = (method: ReadMethod, params?: unknown[], wallet?: string) => Promise<unknown>;
type Sats = number | string;
export type ReconciliationOrder = {
  id: string; status: string; escrow_index: number; escrow_descriptor: string | null; escrow_address: string | null;
  funding_txid: string | null; funding_vout: number | null;
  price_sats: Sats; buyer_commission_sats: Sats; seller_commission_sats: Sats;
  released_txid: string | null; refunded_txid: string | null;
};
export type ReconciliationClaim = {
  order_id: string; purpose: "release" | "refund"; txid: string;
  funding_txid: string; funding_vout: number; psbt_id: string; claim_id: string; state: string;
};
type ChainTransaction = { hex: string; txid?: string; blockhash?: string; confirmations?: number; in_active_chain?: boolean };
class ReviewRequired extends Error {}
function requireProof(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ReviewRequired(message);
}
function sats(value: Sats): bigint {
  requireProof((typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && /^[0-9]+$/.test(value)), "Order amounts need review.");
  return BigInt(value);
}
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
function rawTransaction(value: ChainTransaction, expectedTxid: string) {
  requireProof(typeof value?.hex === "string", "Transaction data is unavailable.");
  const tx = bitcoin.Transaction.fromHex(value.hex);
  requireProof(tx.getId() === expectedTxid, "Transaction identity does not match the reservation.");
  return tx;
}

/** Only positive, confirmed active-chain evidence can authorize reconciliation.
 * Does not sign, finalize, broadcast, unlock a claim or write to a database.
 */
export async function verifyReservedSettlement(args: {
  order: ReconciliationOrder; claim: ReconciliationClaim; psbtBase64: string;
  network: string; refundKind: "return" | "dispute" | "no_shipment" | null;
}, read: ReconciliationReadRpc = (method, params = [], wallet) => rpc(method, params, wallet, AbortSignal.timeout(7000))) {
  try {
    const { order, claim } = args;
    const chain = ({ regtest: "regtest", signet: "signet", testnet: "test" } as Record<string, string>)[args.network];
    requireProof(chain, "Reconciliation is restricted to supported test networks.");
    const network = args.network === "regtest" ? bitcoin.networks.regtest : bitcoin.networks.testnet;
    requireProof(claim.order_id === order.id && ["release", "refund"].includes(claim.purpose) &&
      /^[0-9a-f]{64}$/.test(claim.txid), "Reservation metadata needs review.");
    requireProof(claim.funding_txid === order.funding_txid?.toLowerCase() &&
      Number(claim.funding_vout) === order.funding_vout && Number.isSafeInteger(order.funding_vout) &&
      order.funding_vout! >= 0 && Number.isSafeInteger(order.escrow_index) && order.escrow_index >= 0 &&
      order.escrow_index < 0x80000000, "Funding metadata does not match the order.");
    requireProof(order.status === (claim.purpose === "release" ? "COMPLETED" : "REFUNDED"), "Order status needs review.");
    const recorded = claim.purpose === "release" ? order.released_txid : order.refunded_txid;
    const opposite = claim.purpose === "release" ? order.refunded_txid : order.released_txid;
    requireProof(!opposite && (!recorded || recorded === claim.txid), "Another settlement is already recorded.");
    const keys = legacyEscrowKeys(order.escrow_descriptor);
    const info = await read("getblockchaininfo") as { chain: string; initialblockdownload: boolean };
    requireProof(info.chain === chain && info.initialblockdownload === false, "The node network or synchronization needs review.");

    const locate = async (txid: string): Promise<ChainTransaction> => {
      try { return await read("gettransaction", [txid, true], "escrow1") as ChainTransaction; }
      catch { return await read("getrawtransaction", [txid, true]) as ChainTransaction; }
    };
    const observed = await locate(claim.txid);
    rawTransaction(observed, claim.txid);
    requireProof(Number.isSafeInteger(observed.confirmations) && observed.confirmations! >= 1 &&
      /^[0-9a-f]{64}$/.test(observed.blockhash ?? ""), "The reserved transaction is not confirmed in an active block. The reservation remains blocked.");
    const blockhash = observed.blockhash!;
    // Explicit block lookup proves membership even when txindex is unavailable.
    const included = await read("getrawtransaction", [claim.txid, true, blockhash]) as ChainTransaction;
    requireProof(included.in_active_chain === true && included.blockhash === blockhash &&
      Number.isSafeInteger(included.confirmations) && included.confirmations! >= 1,
    "Active-chain inclusion could not be verified.");
    const tx = rawTransaction(included, claim.txid);
    const header = await read("getblockheader", [blockhash]) as { hash: string; height: number; confirmations: number };
    requireProof(header.hash === blockhash && Number.isSafeInteger(header.height) && header.height >= 0 &&
      Number.isSafeInteger(header.confirmations) && header.confirmations >= 1, "The transaction block is no longer active.");

    const psbt = bitcoin.Psbt.fromBase64(args.psbtBase64, { network });
    requireProof(tx.ins.length === 1 && psbt.inputCount === 1 && tx.version === psbt.version && tx.locktime === psbt.locktime &&
      same(tx.ins[0].hash, psbt.txInputs[0].hash) && tx.ins[0].index === psbt.txInputs[0].index &&
      tx.ins[0].sequence === psbt.txInputs[0].sequence && tx.outs.length === psbt.txOutputs.length &&
      tx.outs.every((out, i) => out.value === psbt.txOutputs[i].value && same(out.script, psbt.txOutputs[i].script)),
    "The confirmed transaction differs from the prepared transaction.");
    requireProof(Buffer.from(tx.ins[0].hash).reverse().toString("hex") === claim.funding_txid &&
      tx.ins[0].index === Number(claim.funding_vout), "The transaction spends a different funding output.");
    const funding = rawTransaction(await locate(claim.funding_txid), claim.funding_txid);
    const input = funding.outs[Number(claim.funding_vout)];
    requireProof(input, "The original funding output is unavailable.");
    const descriptor = order.escrow_descriptor!.replace(/#[a-z0-9]{8}$/i, "")
      .replace(/\[[^\]]*\]/g, origin => origin.replace(/(\d)h/g, "$1'"));
    const policy = new descriptors.Output({ descriptor, index: order.escrow_index, network });
    requireProof(same(input.script, policy.getScriptPubKey()), "The funding script does not match the original escrow.");
    requireProof(order.escrow_address === policy.getAddress(), "The escrow address or its network needs review.");
    const price = sats(order.price_sats), buyerFee = sats(order.buyer_commission_sats), sellerFee = sats(order.seller_commission_sats);
    requireProof(price > BigInt(0) && input.value === price + buyerFee, "The actual escrow amount needs manual review.");
    if (claim.purpose === "refund") requireProof(args.refundKind, "The refund reason is unavailable.");
    const platformAmount = claim.purpose === "release" ? buyerFee + sellerFee : (args.refundKind === "return" ? buyerFee : BigInt(0));
    const payoutScript = (key: string) => {
      const account = descriptors.BIP32.fromBase58(key.replace(/^\[[^\]]*\]/, ""), network);
      return bitcoin.payments.p2wpkh({ pubkey: account.derive(3).derive(order.escrow_index).publicKey, network }).output!;
    };
    const recipient = payoutScript(claim.purpose === "release" ? keys.sellerXpub : keys.buyerXpub);
    const platform = payoutScript(keys.platformXpub);
    const count = claim.purpose === "release" || platformAmount > BigInt(0) ? 2 : 1;
    requireProof(tx.outs.length === count, "The transaction has unexpected outputs.");
    const recipientOut = tx.outs.find(out => same(out.script, recipient));
    const platformOut = tx.outs.find(out => same(out.script, platform));
    requireProof(recipientOut && recipientOut.value > BigInt(0), "The payout destination is not authorized.");
    if (count === 2) requireProof(platformOut && platformOut !== recipientOut && platformOut.value === platformAmount,
      "The platform output does not match the agreed commission.");
    const fee = input.value - tx.outs.reduce((sum, out) => sum + out.value, BigInt(0));
    requireProof(fee >= BigInt(0) && fee <= BigInt(5000), "The network fee is outside the authorized range.");
    // Re-check active membership after all other reads; absence never releases the claim.
    requireProof(await read("getblockhash", [header.height]) === blockhash, "The active chain changed during verification.");
    return { verified: true as const, txid: claim.txid, blockhash, confirmations: Math.min(header.confirmations, included.confirmations!) };
  } catch (error) {
    return { verified: false as const, reason: error instanceof ReviewRequired ? error.message : "The reserved transaction cannot be verified. The reservation remains blocked for review." };
  }
}
