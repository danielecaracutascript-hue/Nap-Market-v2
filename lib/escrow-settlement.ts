import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export function broadcastReceipt(txid: string, reconciliationRequired: boolean, alreadyBroadcast = false) {
  return {
    ok: true,
    broadcast: true,
    txid,
    reconciliationRequired,
    alreadyBroadcast,
    message: reconciliationRequired
      ? "The transaction was sent. Order synchronization needs review. Do not submit another transaction."
      : "The transaction was sent and recorded.",
  };
}

/** Read before signing; a recorded broadcast must never be sent again here.
 * This preserves legacy records; escrow-submission.ts supplies the durable claim.
 * This read alone is not a concurrency lock.
 */
export async function recordedBroadcast(
  admin: SupabaseClient,
  orderId: string,
  purpose: "release" | "refund",
): Promise<string | null> {
  const { data, error } = await admin.from("psbts")
    .select("txid")
    .eq("order_id", orderId)
    .eq("purpose", purpose)
    .in("status", ["broadcast", "confirmed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Could not check previously broadcast transactions. No new transaction was sent.");
  if (!data) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(data.txid ?? "")) {
    throw new Error("A previous broadcast record needs review. No new transaction was sent.");
  }
  return data.txid;
}

/** The SQL function compares this exact public snapshot under the order lock. */
export function settlementSnapshot(order: {
  escrow_descriptor: string | null; escrow_address: string | null; escrow_index: number;
  price_sats: number | string; buyer_commission_sats: number | string; seller_commission_sats: number | string;
}, psbt: string) {
  return { escrow_descriptor: order.escrow_descriptor, escrow_address: order.escrow_address,
    escrow_index: String(order.escrow_index), price_sats: String(order.price_sats),
    buyer_commission_sats: String(order.buyer_commission_sats),
    seller_commission_sats: String(order.seller_commission_sats), psbt };
}
