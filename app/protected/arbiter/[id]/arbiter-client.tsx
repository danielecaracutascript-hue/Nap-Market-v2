"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type Dispute = {
  id: string;
  reason: string;
  description: string;
  status: string;
  decision: string | null;
  decision_notes: string | null;
  opened_by: string;
  opened_at: string;
  arbiter_id: string | null;
  orders: {
    id: string;
    buyer_id: string;
    seller_id: string;
    price_eur_cents: number;
    listings: { title: string } | null;
  } | null;
};

type Profile = {
  id: string;
  handle: string | null;
};

type Ev = { type: string; actor_role: string; created_at: string };

export default function ArbiterClient({ disputeId }: { disputeId: string }) {
  const supabase = createClient();
  const [dispute, setDispute] = useState<Dispute | null>(null);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [events, setEvents] = useState<Ev[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [decision, setDecision] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [me, setMe] = useState("");
  const [loadError, setLoadError] = useState("");

  async function load() {
    setLoaded(false);
    setLoadError("");
    setDispute(null);
    setProfiles({});
    setEvents([]);
    try {
    const { data: auth } = await supabase.auth.getUser();
    setMe(auth.user?.id ?? "");
    if (!auth.user) throw new Error("Sign in to view this dispute.");

    const { data: d, error: disputeError } = await supabase
      .from("disputes")
      .select("*, orders(id, buyer_id, seller_id, price_eur_cents, listings(title))")
      .eq("id", disputeId)
      .maybeSingle();
    if (disputeError) throw new Error("The dispute could not be loaded. Please try again.");
    setDispute(d as Dispute | null);
    if (!d) return;

    if (d?.orders) {
      const userIds = [d.orders.buyer_id, d.orders.seller_id];
      const { data: profs, error: profileError } = await supabase
        .from("public_profiles")
        .select("id, handle")
        .in("id", userIds);
      if (profileError) throw new Error("The parties could not be loaded. Please try again.");
      const profMap = (profs ?? []).reduce((acc, p) => {
        acc[p.id] = p as Profile;
        return acc;
      }, {} as Record<string, Profile>);
      setProfiles(profMap);
    }

    if (!d.orders) throw new Error("The order could not be loaded. Please try again.");
    const { data: ev, error: eventError } = await supabase
      .from("order_events")
      .select("type, actor_role, created_at")
      .eq("order_id", d.orders.id)
      .order("created_at");
    if (eventError) throw new Error("The order history could not be loaded. Please try again.");
    setEvents((ev ?? []) as Ev[]);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "The dispute could not be loaded.");
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disputeId]);

  async function submitDecision(e: FormEvent) {
    e.preventDefault();
    if (!dispute || dispute.status !== "assigned" || dispute.arbiter_id !== me || submitting || loadError) return;
    const explanation = notes.trim();
    if ((decision !== "buyer" && decision !== "seller") || explanation.length < 10) {
      setMessage("Select a decision and explain it in at least 10 characters.");
      return;
    }
    setSubmitting(true);
    setMessage("");
    try {
      const { error } = await supabase.rpc("decide_dispute", {
        p_dispute: disputeId,
        p_decision: decision,
        p_notes: explanation,
      });
      if (error) throw new Error(error.message);
      setMessage("Decision recorded.");
      await load();
    } catch (err) {
      setMessage("Error: " + (err as Error).message);
    }
    setSubmitting(false);
  }

  if (!loaded) return <p className="p-6 text-sm">Loading...</p>;
  if (loadError) return (
    <div className="space-y-3 p-6 text-sm">
      <p role="alert">{loadError}</p>
      <button className="underline" onClick={() => load()}>Try again</button>
    </div>
  );
  if (!dispute) return <p className="p-6 text-sm">Dispute not found.</p>;

  const order = dispute.orders;
  const buyer = order ? profiles[order.buyer_id] : null;
  const seller = order ? profiles[order.seller_id] : null;
  const field = "w-full rounded border bg-transparent px-3 py-2";
  const btn = "rounded bg-foreground px-4 py-2 text-background";

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-6">
      <p className="text-sm">
        <Link className="underline" href="/protected/arbiter">Back to cases</Link>
      </p>
      <h1 className="text-2xl font-bold">Dispute #{dispute.id.slice(0, 8)}</h1>

      <div className="rounded border p-4 text-sm">
        <div className="flex justify-between font-semibold">
          <span>Order: {order?.listings?.title ?? "Unknown"}</span>
          <span>{order ? (order.price_eur_cents / 100).toFixed(2) + " EUR" : ""}</span>
        </div>
        <p className="opacity-70">Reason: {dispute.reason.split("_").join(" ")}</p>
        <p className="opacity-70">Status: {dispute.status}</p>
        <p className="opacity-70">Opened: {new Date(dispute.opened_at).toLocaleString()}</p>
      </div>

      <div className="rounded border p-4 text-sm">
        <p className="font-semibold">Description</p>
        <p className="whitespace-pre-wrap">{dispute.description}</p>
      </div>

      {order && (
        <div className="rounded border p-4 text-sm">
          <p className="font-semibold">Parties</p>
          <p>Buyer: {buyer?.handle ?? "Unknown"}</p>
          <p>Seller: {seller?.handle ?? "Unknown"}</p>
        </div>
      )}

      <div className="rounded border p-4 text-sm">
        <p className="font-semibold">Order History</p>
        <ul className="space-y-1 text-xs opacity-70">
          {events.map((ev, i) => (
            <li key={i}>
              {new Date(ev.created_at).toLocaleString()} - {ev.type} ({ev.actor_role})
            </li>
          ))}
        </ul>
      </div>

      {dispute.status === "assigned" && dispute.arbiter_id === me && (
        <form onSubmit={submitDecision} className="space-y-3 rounded border p-4 text-sm">
          <p className="font-semibold">Your decision</p>
          <p className="text-xs opacity-70">
            Review the evidence and decide in favor of the buyer or seller.
          </p>
          <select className={field} value={decision} onChange={(e) => setDecision(e.target.value)} required>
            <option value="">Select decision...</option>
            <option value="buyer">In favor of buyer (refund)</option>
            <option value="seller">In favor of seller (release to seller)</option>
          </select>
          <textarea
            className={field}
            rows={4}
            placeholder="Explain your decision (at least 10 characters)"
            required
            minLength={10}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <button type="submit" disabled={submitting} className={btn}>
            {submitting ? "Submitting..." : "Submit decision"}
          </button>
        </form>
      )}

      {dispute.status === "decided" && (
        <div className="rounded border p-4 text-sm">
          <p className="font-semibold">Decision: {dispute.decision}</p>
          {dispute.decision_notes && <p className="whitespace-pre-wrap">{dispute.decision_notes}</p>}
        </div>
      )}

      {message && <p className="text-sm">{message}</p>}
    </div>
  );
}
