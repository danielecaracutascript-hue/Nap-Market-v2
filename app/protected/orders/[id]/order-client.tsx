"use client";

import { legacyEscrowKeys } from "@/lib/escrow-legacy-policy";
import { readBroadcastReceipt, receiptStorageKey, receiptMessage } from "@/lib/escrow-receipt";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { releaseAmounts, payoutAddress, verifyReleasePsbt, derivePubkey, signWith, refundKindFromEvents, refundAmounts, verifyRefundPsbt, hexOf } from "@/lib/escrow";
import { loadRecord, unlock } from "@/lib/wallet";

const TEST_MODE = process.env.NEXT_PUBLIC_TEST_MODE === "true";

type Order = {
  id: string;
  status: string;
  buyer_id: string;
  seller_id: string;
  price_eur_cents: number;
  shipping_eur_cents: number;
  btc_eur_rate: number;
  price_sats: number;
  buyer_commission_sats: number;
  seller_commission_sats: number;
  shipping_sats: number;
  dest_country: string;
  expires_at: string;
  escrow_index: number;
  carrier: string | null;
  tracking_number: string | null;
  delivered_at: string | null;
  window_ends_at: string | null;
  return_deadline: string | null;
  return_tracking_number: string | null;
  escrow_address: string | null;
  escrow_descriptor: string | null;
  shipping_address: string | null;
  funding_txid: string | null;
  funding_vout: number | null;
  released_txid: string | null;
  refunded_txid: string | null;
};
type Ev = { type: string; actor_role: string; created_at: string; data?: { decision?: string } | null };
type Dispute = {
  id: string;
  reason: string;
  description: string;
  status: string;
  decision: string | null;
  decision_notes: string | null;
  opened_by: string;
};
type Review = { reviewer_id: string; rating: number; comment: string | null };
type Fn =
  | "simulate_payment"
  | "cancel_order"
  | "simulate_delivery"
  | "confirm_delivery"
  | "confirm_receipt"
  | "request_return"
  | "test_expire_window"
  | "confirm_return_received";

const eur = (cents: number) => (cents / 100).toFixed(2) + " EUR";
const btc = (sats: number) => (sats / 1e8).toFixed(8) + " BTC";
const when = (d: string | null) => (d ? new Date(d).toLocaleString() : "");

function isDue(o: Order) {
  const now = Date.now();
  if (o.status === "DELIVERED" && o.window_ends_at) return new Date(o.window_ends_at).getTime() <= now;
  if (o.status === "RETURN_REQUESTED" && o.return_deadline) return new Date(o.return_deadline).getTime() <= now;
  return false;
}

export default function OrderClient({ orderId }: { orderId: string }) {
  const supabase = createClient();
  const [me, setMe] = useState("");
  const [order, setOrder] = useState<Order | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [rating, setRating] = useState("5");
  const [comment, setComment] = useState("");
  const [returnTracking, setReturnTracking] = useState("");
  const [dispute, setDispute] = useState<Dispute | null>(null);
  const [showDispute, setShowDispute] = useState(false);
  const [reason, setReason] = useState("not_as_described");
  const [disputeText, setDisputeText] = useState("");
  const [paying, setPaying] = useState(false);
  const [pw, setPw] = useState("");
  const [releasing, setReleasing] = useState(false);
  const [settlementPending, setSettlementPending] = useState(false);
  const [releaseNote, setReleaseNote] = useState("");
  const [checkingSettlement, setCheckingSettlement] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const actionRunning = useRef(false);
  const loadGeneration = useRef(0);

  async function fetchOrder() {
    const { data, error } = await supabase.from("orders").select("*").eq("id", orderId).maybeSingle();
    if (error) throw new Error("The order could not be loaded.");
    return data as Order | null;
  }

  async function load() {
    const request = ++loadGeneration.current;
    setLoaded(false);
    setLoadError("");
    setOrder(null);
    setEvents([]);
    setReviews([]);
    setDispute(null);
    try {
    const { data: auth, error: authError } = await supabase.auth.getUser();
    if (request !== loadGeneration.current) return false;
    setMe(auth.user?.id ?? "");
    if (authError || !auth.user) throw new Error("Sign in again to view this order.");
    let o = await fetchOrder();
    if (request !== loadGeneration.current) return false;
    if (!o) return true;
    if (o && isDue(o)) {
      const { error } = await supabase.rpc("finalize_order", { p_order: orderId });
      if (request !== loadGeneration.current) return false;
      if (error) throw new Error("The order status could not be refreshed.");
      o = await fetchOrder();
      if (request !== loadGeneration.current) return false;
      if (!o) throw new Error("The order could not be reloaded.");
    }
    const { data: ev, error: eventError } = await supabase
      .from("order_events")
      .select("type, actor_role, created_at, data")
      .eq("order_id", orderId)
      .order("created_at");
    if (request !== loadGeneration.current) return false;
    if (eventError) throw new Error("The order history could not be loaded.");
    const { data: rv, error: reviewError } = await supabase
      .from("reviews")
      .select("reviewer_id, rating, comment")
      .eq("order_id", orderId);
    if (request !== loadGeneration.current) return false;
    if (reviewError) throw new Error("The order reviews could not be loaded.");
    const { data: dp, error: disputeError } = await supabase
      .from("disputes")
      .select("id, reason, description, status, decision, decision_notes, opened_by")
      .eq("order_id", orderId)
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (request !== loadGeneration.current) return false;
    if (disputeError) throw new Error("The order dispute could not be loaded.");
    setOrder(o);
    setEvents((ev ?? []) as Ev[]);
    setReviews((rv ?? []) as Review[]);
    setDispute(dp as Dispute | null);
    return true;
    } catch (error) {
      if (request !== loadGeneration.current) return false;
      setLoadError((error instanceof Error ? error.message : "The order could not be loaded.") +
        " Try again before taking further action.");
      return false;
    } finally {
      if (request === loadGeneration.current) setLoaded(true);
    }
  }

  useEffect(() => {
    const generation = loadGeneration;
    load();
    return () => { generation.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  async function runOrderAction(
    operation: () => PromiseLike<{ error: { message: string } | null }>,
    onSuccess?: () => void,
  ) {
    if (actionRunning.current || !loaded || !order || paying || releasing || checkingSettlement) return;
    actionRunning.current = true;
    setActionBusy(true);
    setMessage("");
    try {
      const { error } = await operation();
      if (error) setMessage("Error: " + error.message);
      else onSuccess?.();
    } catch {
      setMessage("The action could not be confirmed. Check the refreshed order before trying again.");
    } finally {
      await load();
      actionRunning.current = false;
      setActionBusy(false);
    }
  }

  async function act(fn: Fn) {
    await runOrderAction(() => supabase.rpc(fn, { p_order: orderId }));
  }

  async function ship(e: FormEvent) {
    e.preventDefault();
    await runOrderAction(() => supabase.rpc("mark_shipped", {
      p_order: orderId,
      p_carrier: carrier,
      p_tracking: tracking,
    }));
  }

  async function openDispute(e: FormEvent) {
    e.preventDefault();
    await runOrderAction(() => supabase.rpc("open_dispute", {
      p_order: orderId,
      p_reason: reason,
      p_description: disputeText,
    }), () => setShowDispute(false));
  }

  // Retain only the public receipt, so a page reload does not invite a retry.
  useEffect(() => {
    setSettlementPending(false);
    setMessage("");
    if (!me) return;
    try {
      const saved = sessionStorage.getItem(receiptStorageKey(me, orderId));
      const receipt = saved ? readBroadcastReceipt(JSON.parse(saved)) : null;
      if (receipt) {
        setSettlementPending(true);
        setMessage(receiptMessage(receipt));
      }
    } catch { /* Storage may be unavailable; server checks remain in place. */ }
  }, [me, orderId]);

  function showBroadcastReceipt(result: unknown) {
    const receipt = readBroadcastReceipt(result);
    if (!receipt) return false;
    setPw("");
    setSettlementPending(true);
    setMessage(receiptMessage(receipt));
    try {
      sessionStorage.setItem(receiptStorageKey(me, orderId), JSON.stringify(receipt));
    } catch { /* Keep the visible receipt even when storage is unavailable. */ }
    return true;
  }

  async function checkSettlementStatus() {
    if (checkingSettlement) return;
    setCheckingSettlement(true);
    try {
      const response = await fetch("/api/orders/" + orderId + "/settlement/reconcile", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Transaction status is unavailable");
      const receipt = readBroadcastReceipt(result);
      if (receipt) showBroadcastReceipt(result);
      if (result.message) setMessage(result.message + (receipt ? " Transaction " + receipt.txid : ""));
    } catch (error) {
      setMessage("Error: " + (error as Error).message);
    } finally {
      setCheckingSettlement(false);
      await load();
    }
  }

  async function releaseFunds(e: FormEvent) {
    e.preventDefault();
    if (!order || settlementPending) return;
    setReleasing(true);
    setMessage("");
    setReleaseNote("");
    try {
      const rec = loadRecord(me);
      if (!rec) throw new Error("No wallet on this device. Restore it from your 12 words in My wallet.");
      const res = await fetch("/api/orders/" + orderId + "/release/prepare", { method: "POST" });
      const j = await res.json();
      if (showBroadcastReceipt(j)) return;
      if (!res.ok) throw new Error(j.error ?? "Could not prepare the release");

      // 1. Il dispositivo controlla la transazione prima di firmare
      const { escrowTotal, platform } = releaseAmounts(order);
      const { sellerXpub, platformXpub } = legacyEscrowKeys(order.escrow_descriptor);
      const sellerPub = await derivePubkey(sellerXpub, 0, order.escrow_index);
      const walletPub = await derivePubkey(rec.xpub, 0, order.escrow_index);
      if (hexOf(walletPub) !== hexOf(sellerPub)) {
        throw new Error("This order requires its original wallet. Restore that wallet before continuing.");
      }
      const sellerAddr = await payoutAddress(sellerXpub, 3, order.escrow_index);
      const platformAddr = await payoutAddress(platformXpub, 3, order.escrow_index);
      const v = await verifyReleasePsbt({
        psbtBase64: j.psbt,
        fundingTxid: order.funding_txid ?? "",
        fundingVout: Number(order.funding_vout),
        escrowTotal,
        platformAmount: platform,
        sellerAddress: sellerAddr,
        platformAddress: platformAddr,
        maxFee: 5000,
      });
      if (!v.ok) throw new Error("Verification failed, nothing was signed: " + v.reason);
      setReleaseNote("Verified. You receive " + btc(v.sellerAmount ?? 0) + " at " + sellerAddr + " (network fee " + v.fee + " sat, platform commission " + btc(platform) + ").");

      // 2. Firma solo con la propria chiave
      const mnemonic = await unlock(rec, pw);
      const signed = await signWith({ mnemonic, psbtBase64: j.psbt, keepPubkeys: [sellerPub] });

      // 3. La piattaforma applica la sua regola, firma e trasmette
      const res2 = await fetch("/api/orders/" + orderId + "/release/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ psbt: signed }),
      });
      const j2 = await res2.json();
      if (showBroadcastReceipt(j2)) return;
      if (!res2.ok) throw new Error(j2.error ?? "Release failed");
      setPw("");
      setMessage("Funds released. Transaction " + j2.txid);
    } catch (err) {
      setMessage("Error: " + (err as Error).message);
    } finally {
      setReleasing(false);
      await load();
    }
  }

  async function claimRefund(e: FormEvent) {
    e.preventDefault();
    if (!order || settlementPending) return;
    setReleasing(true);
    setMessage("");
    setReleaseNote("");
    try {
      const rec = loadRecord(me);
      if (!rec) throw new Error("No wallet on this device. Restore it from your 12 words in My wallet.");
      const kind = refundKindFromEvents(events);
      if (!kind) throw new Error("No refund reason is recorded for this order");
      const res = await fetch("/api/orders/" + orderId + "/refund/prepare", { method: "POST" });
      const j = await res.json();
      if (showBroadcastReceipt(j)) return;
      if (!res.ok) throw new Error(j.error ?? "Could not prepare the refund");

      // 1. Il dispositivo controlla la transazione prima di firmare
      const { escrowTotal, platform } = refundAmounts(order, kind);
      const { buyerXpub, platformXpub } = legacyEscrowKeys(order.escrow_descriptor);
      const buyerPub = await derivePubkey(buyerXpub, 0, order.escrow_index);
      const walletPub = await derivePubkey(rec.xpub, 0, order.escrow_index);
      if (hexOf(walletPub) !== hexOf(buyerPub)) {
        throw new Error("This order requires its original wallet. Restore that wallet before continuing.");
      }
      const buyerAddr = await payoutAddress(buyerXpub, 3, order.escrow_index);
      const platformAddr = await payoutAddress(platformXpub, 3, order.escrow_index);
      const v = await verifyRefundPsbt({
        psbtBase64: j.psbt,
        fundingTxid: order.funding_txid ?? "",
        fundingVout: Number(order.funding_vout),
        escrowTotal,
        platformAmount: platform,
        buyerAddress: buyerAddr,
        platformAddress: platformAddr,
        maxFee: 5000,
      });
      if (!v.ok) throw new Error("Verification failed, nothing was signed: " + v.reason);
      setReleaseNote("Verified. You receive " + btc(v.buyerAmount ?? 0) + " at " + buyerAddr + " (network fee " + v.fee + " sat" + (platform > 0 ? ", platform keeps " + btc(platform) : "") + ").");

      // 2. Firma solo con la propria chiave
      const mnemonic = await unlock(rec, pw);
      const signed = await signWith({ mnemonic, psbtBase64: j.psbt, keepPubkeys: [buyerPub] });

      // 3. La piattaforma applica la sua regola, firma e trasmette
      const res2 = await fetch("/api/orders/" + orderId + "/refund/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ psbt: signed }),
      });
      const j2 = await res2.json();
      if (showBroadcastReceipt(j2)) return;
      if (!res2.ok) throw new Error(j2.error ?? "Refund failed");
      setPw("");
      setMessage("Refund sent. Transaction " + j2.txid);
    } catch (err) {
      setMessage("Error: " + (err as Error).message);
    } finally {
      setReleasing(false);
      await load();
    }
  }

  async function paymentRequest(action: "escrow" | "check-payment") {
    if (paying) return;
    setPaying(true);
    setMessage("");
    try {
      const res = await fetch("/api/orders/" + orderId + "/" + action, { method: "POST" });
      const result: unknown = await res.json();
      if (!result || typeof result !== "object") throw new Error("Invalid payment response");
      const body = result as { message?: unknown; error?: unknown };
      const message = typeof body.message === "string" && body.message
        ? body.message : typeof body.error === "string" && body.error ? body.error : null;
      if (!res.ok && !message) throw new Error("Payment response unavailable");
      setMessage(message ?? "Payment check completed. Refresh the order to verify its status.");
    } catch {
      setMessage("Payment details or status could not be verified. Refresh the order and check again. Do not send another payment until the status is clear.");
    } finally {
      try {
        if (!await load()) throw new Error("Order refresh unavailable");
      } catch {
        setMessage("The order could not be refreshed. Payment status needs review. Do not send another payment until the status is clear.");
      } finally {
        setPaying(false);
      }
    }
  }

  async function createPayment() {
    await paymentRequest("escrow");
  }

  async function checkPayment() {
    await paymentRequest("check-payment");
  }

  async function shipReturn(e: FormEvent) {
    e.preventDefault();
    await runOrderAction(() => supabase.rpc("ship_return", {
      p_order: orderId,
      p_tracking: returnTracking,
    }));
  }

  async function submitReview(e: FormEvent) {
    e.preventDefault();
    if (!order) return;
    const other = order.buyer_id === me ? order.seller_id : order.buyer_id;
    await runOrderAction(() => supabase.from("reviews").insert({
      order_id: orderId,
      reviewer_id: me,
      reviewee_id: other,
      rating: Number(rating),
      comment: comment.trim() || null,
    }));
  }

  if (!loaded) return <p className="p-6 text-sm">Loading...</p>;
  if (loadError) return (
    <div className="space-y-3 p-6 text-sm">
      <p role="alert">{loadError}</p>
      {message && <p role="status">{message}</p>}
      <button className="underline" onClick={() => load()}>Try again</button>
      <p><Link className="underline" href="/protected/orders">My orders</Link></p>
    </div>
  );
  if (!order) return (
    <div className="space-y-3 p-6 text-sm">
      <p>Order not found.</p>
      {message && <p role="status">{message}</p>}
      <Link className="underline" href="/protected/orders">My orders</Link>
    </div>
  );

  const isBuyer = order.buyer_id === me;
  const isSeller = order.seller_id === me;
  const paymentDetailsExist = [order.escrow_address, order.escrow_descriptor, order.shipping_address,
    order.funding_txid, order.funding_vout].some((value) => value !== null && value !== undefined);
  const myReview = reviews.find((r) => r.reviewer_id === me);
  const field = "w-full rounded border bg-transparent px-3 py-2";
  const btn = "rounded bg-foreground px-4 py-2 text-background";
  const btnOutline = "rounded border px-4 py-2";

  return (
    <div className="mx-auto w-full max-w-md space-y-4 p-6">
      <fieldset disabled={actionBusy} className="min-w-0 space-y-4">
      {actionBusy && <p role="status" className="text-sm">Updating order...</p>}
      <p className="text-sm">
        <Link className="underline" href="/protected/orders">My orders</Link>
        {" · "}
        <Link className="underline" href="/protected/listings">Listings</Link>
      </p>
      <h1 className="text-2xl font-bold">Order {order.id.slice(0, 8)}</h1>
      <p className="text-sm opacity-70">{isBuyer ? "You are the buyer" : isSeller ? "You are the seller" : ""}</p>
      <p className="rounded border p-3 text-sm">Status: <b>{order.status}</b></p>
      {(isBuyer || isSeller) && (settlementPending || order.status === "COMPLETED" || order.status === "REFUNDED") && (
        <button type="button" onClick={checkSettlementStatus} disabled={checkingSettlement || releasing} className={btnOutline}>
          {checkingSettlement ? "Checking transaction..." : "Check transaction status"}
        </button>
      )}

      <div className="space-y-1 rounded border p-4 text-sm">
        <div className="flex justify-between"><span>Price</span><span>{eur(order.price_eur_cents)}</span></div>
        <div className="flex justify-between"><span>Shipping to {order.dest_country}</span><span>{eur(order.shipping_eur_cents)}</span></div>
        <div className="pt-2 opacity-70">
          {isBuyer && <p>Escrow (price + buyer commission): {btc(order.price_sats + order.buyer_commission_sats)}</p>}
          {isBuyer && <p>Shipping wallet: {btc(order.shipping_sats)}</p>}
          {isSeller && <p>You receive on release (price minus seller commission, before network fees): {btc(order.price_sats - order.seller_commission_sats)}</p>}
          <p>Rate: 1 BTC = {order.btc_eur_rate} EUR</p>
          {order.status === "CREATED" && <p>Pay before: {when(order.expires_at)}</p>}
        </div>
      </div>

      {order.carrier && (
        <div className="rounded border p-4 text-sm">
          <p>Carrier: {order.carrier}</p>
          <p>Tracking: {order.tracking_number}</p>
        </div>
      )}

      {order.status === "CREATED" && isBuyer && (
        <div className="flex gap-3">
          {TEST_MODE && <button onClick={() => act("simulate_payment")} className={btn}>Simulate payment (test only)</button>}
          {!TEST_MODE && order.escrow_address && <p className="text-sm opacity-70">Automatic test-wallet payments are temporarily unavailable. Use the payment details below, then check the payment.</p>}
          {!paymentDetailsExist && <button onClick={() => act("cancel_order")} className={btnOutline}>Cancel order</button>}
          {paymentDetailsExist && <p className="text-sm">Payment details have been prepared or funding needs review. Automatic cancellation is unavailable; manual review is required even if payment is not yet recorded.</p>}
        </div>
      )}
      {order.status === "CREATED" && isBuyer && !order.escrow_address && (
        <button onClick={createPayment} disabled={paying} className={btn}>
          {paying ? "Preparing..." : "Get payment details"}
        </button>
      )}
      {order.status === "CREATED" && isBuyer && order.escrow_address && !TEST_MODE && (
        <div className="space-y-2 rounded border p-4 text-sm">
          <p className="font-semibold">Payment Details</p>
          <p>1. Escrow address. Send {btc(order.price_sats + order.buyer_commission_sats)}:</p>
          <p className="break-all rounded border p-2 font-mono text-xs">{order.escrow_address}</p>
          <p>2. Shipping address. Send {btc(order.shipping_sats)}:</p>
          <p className="break-all rounded border p-2 font-mono text-xs">{order.shipping_address}</p>
          <p className="text-xs opacity-70">You can pay both in one transaction with two outputs, or in two transactions. Each needs 1 confirmation.</p>
          <button onClick={checkPayment} disabled={paying} className={btnOutline}>
            {paying ? "Checking..." : "Check payment"}
          </button>
        </div>
      )}

      {order.status === "CREATED" && isSeller && <p className="text-sm">Waiting for the buyer to pay.</p>}

      {order.status === "FUNDED" && isBuyer && (
        <p className="text-sm">Payment received. Waiting for the seller to ship (within 5 working days).</p>
      )}
      {order.status === "FUNDED" && isSeller && (
        <form onSubmit={ship} className="space-y-2 rounded border p-4">
          <p className="font-semibold">Confirm shipment</p>
          <p className="text-xs opacity-70">{TEST_MODE ? "Test mode: enter a test carrier and tracking number." : "Enter the carrier and tracking number for this shipment."}</p>
          <input className={field} placeholder="Carrier (e.g. TestCarrier)" value={carrier} onChange={(e) => setCarrier(e.target.value)} required />
          <input className={field} placeholder="Tracking number" value={tracking} onChange={(e) => setTracking(e.target.value)} required />
          <button type="submit" className={btn}>Confirm shipment</button>
        </form>
      )}

      {order.status === "SHIPPED" && (
        <div className="space-y-2">
          <p className="text-sm">{isBuyer ? "Your order is on its way." : "Shipped. Waiting for delivery."}</p>
          {isBuyer && <button onClick={() => act("confirm_delivery")} className={btn}>Confirm delivery received</button>}
          {TEST_MODE && <button onClick={() => act("simulate_delivery")} className={btnOutline}>Simulate delivery (test only)</button>}
        </div>
      )}

      {order.status === "DELIVERED" && (
        <div className="space-y-2 rounded border p-4 text-sm">
          <p>Delivered {when(order.delivered_at)}.</p>
          <p>The buyer can confirm, or request a return, until {when(order.window_ends_at)}. After that the order can complete and the seller can claim the funds.</p>
          {isBuyer && (
            <div className="flex gap-3 pt-1">
              <button onClick={() => act("confirm_receipt")} className={btn}>Confirm receipt</button>
              <button onClick={() => act("request_return")} className={btnOutline}>Request a return</button>
              <button onClick={() => setShowDispute(true)} className={btnOutline}>Open a dispute</button>
            </div>
          )}
          {TEST_MODE && <button onClick={() => act("test_expire_window")} className="text-xs underline">Test only: end the 14-day window now</button>}
        </div>
      )}

      {order.status === "RETURN_REQUESTED" && (
        <div className="space-y-2 rounded border p-4 text-sm">
          <p>{isBuyer ? "Return requested. Ship the item back by " : "The buyer requested a return. They must ship it back by "}{when(order.return_deadline)}.</p>
          <p className="opacity-70">If the item is not shipped back in time, the order completes.</p>
          {TEST_MODE && <button onClick={() => act("test_expire_window")} className="text-xs underline">Test only: end the 7-day deadline now</button>}
        </div>
      )}

      {order.status === "RETURN_REQUESTED" && isBuyer && (
        <form onSubmit={shipReturn} className="space-y-2 rounded border p-4">
          <p className="font-semibold">Ship the item back</p>
          <p className="text-xs opacity-70">Return shipping is paid by you. Enter the tracking number of the return parcel.</p>
          <input className={field} placeholder="Return tracking number" value={returnTracking} onChange={(e) => setReturnTracking(e.target.value)} required />
          <button type="submit" className={btn}>Confirm return shipment</button>
        </form>
      )}

      {order.status === "RETURN_SHIPPED" && (
        <div className="space-y-2 rounded border p-4 text-sm">
          <p>Return tracking: {order.return_tracking_number}</p>
          {isSeller ? (
            <>
              <p>When the item is back and in the expected condition, confirm to approve the buyer&apos;s refund.</p>
              <button onClick={() => act("confirm_return_received")} className={btn}>Confirm return received</button>
              <button onClick={() => setShowDispute(true)} className={btnOutline}>Dispute the return</button>
            </>
          ) : (
            <p>The return is on its way. Once the seller confirms receipt, you can claim the approved refund.</p>
          )}
        </div>
      )}

      {order.status === "REFUNDED" && isBuyer && !order.refunded_txid && (
        <form onSubmit={claimRefund} className="space-y-2 rounded border p-4 text-sm">
          <p className="font-semibold">Claim your refund</p>
          <p className="text-xs opacity-70">Your device checks the transaction (amounts and destination) before signing. The platform then adds its signature and broadcasts it.</p>
          <input className={field} type="password" placeholder="Wallet password" value={pw}
            onChange={(e) => setPw(e.target.value)} required autoComplete="current-password" />
          <button type="submit" disabled={releasing || settlementPending} className={btn}>
            {releasing ? "Working..." : "Review, sign and claim refund"}
          </button>
          {releaseNote && <p>{releaseNote}</p>}
        </form>
      )}
      {order.status === "REFUNDED" && order.refunded_txid && (
        <div className="rounded border p-4 text-sm">
          <p className="font-semibold">Refund transaction recorded.</p>
          <p>Transaction: {order.refunded_txid}</p>
        </div>
      )}

      {showDispute && ((order.status === "DELIVERED" && isBuyer) || (order.status === "RETURN_SHIPPED" && isSeller)) && (
        <form onSubmit={openDispute} className="space-y-2 rounded border p-4">
          <p className="font-semibold">Open a dispute</p>
          <p className="text-xs opacity-70">An arbiter will review the case. The party who loses pays a 5 EUR dispute fee. Photo and video evidence upload comes in the next step.</p>
          <select className={field} value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="not_as_described">Item not as described</option>
            <option value="damaged">Item damaged</option>
            <option value="missing">Item or part missing</option>
            <option value="other">Other</option>
          </select>
          <textarea className={field} rows={4} placeholder="Describe the problem (at least 10 characters)" value={disputeText} onChange={(e) => setDisputeText(e.target.value)} required minLength={10} />
          <div className="flex gap-3">
            <button type="submit" className={btn}>Send dispute</button>
            <button type="button" onClick={() => setShowDispute(false)} className={btnOutline}>Cancel</button>
          </div>
        </form>
      )}

      {order.status === "DISPUTED" && dispute && (
        <div className="space-y-1 rounded border p-4 text-sm">
          <p className="font-semibold">Dispute open</p>
          <p>Reason: {dispute.reason.split("_").join(" ")} ({dispute.opened_by === me ? "opened by you" : "opened by the other party"})</p>
          <p className="whitespace-pre-wrap">{dispute.description}</p>
          <p className="opacity-70">{dispute.status === "assigned" ? "An arbiter is reviewing the case." : "Waiting for an arbiter to be assigned."}</p>
        </div>
      )}

      {dispute && dispute.status === "decided" && (
        <div className="space-y-1 rounded border p-4 text-sm">
          <p className="font-semibold">Dispute decided in favor of the {dispute.decision}</p>
          <p className="whitespace-pre-wrap">{dispute.decision_notes}</p>
        </div>
      )}

      {order.status === "COMPLETED" && isSeller && !order.released_txid && (
        <form onSubmit={releaseFunds} className="space-y-2 rounded border p-4 text-sm">
          <p className="font-semibold">Release your funds</p>
          <p className="text-xs opacity-70">Your device checks the transaction (amounts and destination) before signing. The platform then adds its signature and broadcasts it.</p>
          <input className={field} type="password" placeholder="Wallet password" value={pw}
            onChange={(e) => setPw(e.target.value)} required autoComplete="current-password" />
          <button type="submit" disabled={releasing || settlementPending} className={btn}>
            {releasing ? "Working..." : "Review, sign and release"}
          </button>
          {releaseNote && <p>{releaseNote}</p>}
        </form>
      )}

      {order.status === "COMPLETED" && order.released_txid && (
        <p className="rounded border p-3 text-sm">
          Release transaction recorded: <span className="break-all font-mono text-xs">{order.released_txid}</span>
        </p>
      )}

      {order.status === "REFUNDED" && isSeller && !order.refunded_txid && (
        <p className="rounded border p-3 text-sm">Refund approved. The buyer can now claim the refund.</p>
      )}

      {order.status === "COMPLETED" && (
        <div className="space-y-3 rounded border p-4 text-sm">
          <p className="font-semibold">Order completed.</p>
          {!order.released_txid && <p className="text-sm">Bitcoin release has not yet been recorded for this order.</p>}
          {reviews.map((r, i) => (
            <p key={i}>{r.reviewer_id === me ? "Your review" : "Their review"}: {r.rating}/5{r.comment ? " - " + r.comment : ""}</p>
          ))}
          {!myReview && (isBuyer || isSeller) && (
            <form onSubmit={submitReview} className="space-y-2">
              <p className="font-semibold">Leave a review</p>
              <select className={field} value={rating} onChange={(e) => setRating(e.target.value)}>
                {[5, 4, 3, 2, 1].map((n) => (<option key={n} value={n}>{n} / 5</option>))}
              </select>
              <textarea className={field} rows={2} placeholder="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
              <button type="submit" className={btn}>Send review</button>
            </form>
          )}
        </div>
      )}

      {message && <p className="text-sm">{message}</p>}

      <div className="text-sm">
        <p className="mb-1 font-semibold">History</p>
        <ul className="space-y-1 opacity-80">
          {events.map((e, i) => (
            <li key={i}>{when(e.created_at)} - {e.type} ({e.actor_role})</li>
          ))}
        </ul>
      </div>
      </fieldset>
    </div>
  );
}








