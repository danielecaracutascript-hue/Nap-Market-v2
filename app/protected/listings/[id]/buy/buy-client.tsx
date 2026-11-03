"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Address = { id: string; country: string; full_text: string };
type Quote = {
  price_eur_cents: number;
  buyer_fee_eur_cents: number;
  shipping_eur_cents: number;
  total_eur_cents: number;
  btc_eur: number;
  price_sats: number;
  buyer_commission_sats: number;
  shipping_sats: number;
};

const eur = (cents: number) => (cents / 100).toFixed(2) + " EUR";
const btc = (sats: number) => (sats / 1e8).toFixed(8) + " BTC";

export default function BuyClient({ listingId }: { listingId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [selected, setSelected] = useState("");
  const [newCountry, setNewCountry] = useState("");
  const [newText, setNewText] = useState("");
  const [quoteState, setQuote] = useState<{
    listingId: string; addressId: string; country: string; value: Quote;
  } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [creationUncertain, setCreationUncertain] = useState(false);
  const [createdOrderId, setCreatedOrderId] = useState<string | null>(null);
  const [savingAddress, setSavingAddress] = useState(false);
  const creating = useRef(false);
  const saving = useRef(false);
  const addressLoad = useRef(0);
  const quote = quoteState?.listingId === listingId && quoteState.addressId === selected &&
    addresses.some((a) => a.id === selected && a.country === quoteState.country)
    ? quoteState.value : null;

  async function loadAddresses(selectId?: string) {
    const request = ++addressLoad.current;
    try {
      const { data, error } = await supabase.rpc("my_addresses");
      if (request !== addressLoad.current) return;
      if (error) throw new Error("Addresses unavailable");
      const list = (data ?? []) as Address[];
      setAddresses(list);
      setSelected(list.some((a) => a.id === (selectId ?? selected))
        ? (selectId ?? selected) : (list[0]?.id ?? ""));
    } catch {
      if (request !== addressLoad.current) return;
      setAddresses([]);
      setSelected("");
      setQuote(null);
      setMessage("Addresses could not be loaded. Reload the page to try again.");
    }
  }

  useEffect(() => {
    loadAddresses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function getQuote() {
      setQuote(null);
      const addr = addresses.find((a) => a.id === selected);
      if (!addr) return;
      setMessage("");
      try {
        const { data, error } = await supabase.rpc("quote_order", {
          p_listing: listingId,
          p_dest: addr.country,
        });
        if (cancelled) return;
        if (error) {
          setMessage("Error: " + error.message);
          return;
        }
        if (!data) {
          setMessage("The quote is unavailable. Please try again.");
          return;
        }
        setQuote({ listingId, addressId: addr.id, country: addr.country, value: data as Quote });
      } catch {
        if (!cancelled) setMessage("The quote could not be loaded. Please try again.");
      }
    }
    getQuote();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingId, selected, addresses]);

  async function saveAddress(e: FormEvent) {
    e.preventDefault();
    if (creating.current || saving.current) return;
    saving.current = true;
    setSavingAddress(true);
    setMessage("");
    try {
      const { data, error } = await supabase.rpc("save_address", {
        p_country: newCountry,
        p_text: newText,
      });
      if (error) {
        setMessage("Error: " + error.message);
        return;
      }
      setNewCountry("");
      setNewText("");
      await loadAddresses(data as string);
    } catch {
      setMessage("Address saving could not be confirmed. Reload the page and check your addresses before saving again.");
    } finally {
      saving.current = false;
      setSavingAddress(false);
    }
  }

  async function createOrder() {
    if (creating.current || saving.current || busy || !quote || !selected) return;
    creating.current = true;
    setBusy(true);
    setMessage("");
    try {
      const { data, error } = await supabase.rpc("create_order", {
        p_listing: listingId,
        p_address: selected,
      });
      if (error) {
        // Validation/permission SQL errors roll back the database operation.
        // Connection/protocol errors do not prove that creation failed.
        if (/^(22|23|28|42|P0)[0-9A-Z]{3}$/.test(error.code ?? "")) {
          creating.current = false;
          setMessage("Error: " + error.message);
          return;
        }
        throw new Error("Order creation outcome unavailable");
      }
      if (typeof data !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data)) {
        throw new Error("Order creation response invalid");
      }
      setCreatedOrderId(data);
      try {
        router.push("/protected/orders/" + data);
      } catch {
        setMessage("The order was created. Open it using the link below.");
      }
    } catch {
      setCreationUncertain(true);
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full rounded border bg-transparent px-3 py-2";

  return (
    <div className="mx-auto w-full max-w-md space-y-5 p-6">
      <p className="text-sm">
        <Link className="underline" href={"/protected/listings/" + listingId}>Back to listing</Link>
      </p>
      <h1 className="text-2xl font-bold">Checkout</h1>

      <div className="space-y-2">
        <h2 className="font-semibold">Shipping address</h2>
        {addresses.length > 0 && (
          <select className={field} value={selected} onChange={(e) => setSelected(e.target.value)} disabled={busy || savingAddress || creationUncertain || !!createdOrderId}>
            {addresses.map((a) => (
              <option key={a.id} value={a.id}>
                {a.country} - {a.full_text.slice(0, 40)}
              </option>
            ))}
          </select>
        )}
        <form onSubmit={saveAddress} className="space-y-2 rounded border p-3">
          <p className="text-sm font-semibold">Add an address</p>
          <p className="text-xs opacity-70">Test mode: addresses are not encrypted yet. Use fake data only.</p>
          <input className={field} placeholder="Country (2 letters, e.g. IT)" value={newCountry}
            onChange={(e) => setNewCountry(e.target.value)} maxLength={2} minLength={2} disabled={busy || savingAddress || creationUncertain || !!createdOrderId} required />
          <textarea className={field} rows={3} placeholder="Full name and address" value={newText}
            onChange={(e) => setNewText(e.target.value)} disabled={busy || savingAddress || creationUncertain || !!createdOrderId} required />
          <button type="submit" disabled={busy || savingAddress || creationUncertain || !!createdOrderId} className="rounded border px-3 py-1 text-sm">{savingAddress ? "Saving..." : "Save address"}</button>
        </form>
      </div>

      {quote && (
        <div className="space-y-1 rounded border p-4 text-sm">
          <div className="flex justify-between"><span>Price</span><span>{eur(quote.price_eur_cents)}</span></div>
          <div className="flex justify-between"><span>Buyer fee</span><span>{eur(quote.buyer_fee_eur_cents)}</span></div>
          <div className="flex justify-between"><span>Shipping</span><span>{eur(quote.shipping_eur_cents)}</span></div>
          <div className="flex justify-between border-t pt-1 font-semibold"><span>Total</span><span>{eur(quote.total_eur_cents)}</span></div>
          <div className="pt-2 opacity-70">
            <p>Escrow: {btc(quote.price_sats + quote.buyer_commission_sats)}</p>
            <p>Shipping wallet: {btc(quote.shipping_sats)}</p>
            <p>Rate locked when you create the order: 1 BTC = {quote.btc_eur} EUR</p>
          </div>
          <button onClick={createOrder} disabled={busy || savingAddress || creationUncertain || !!createdOrderId}
            className="mt-2 rounded bg-foreground px-4 py-2 text-background disabled:opacity-50">
            {busy ? "Creating..." : createdOrderId ? "Order created" : "Create order"}
          </button>
        </div>
      )}
      {message && <p className="text-sm">{message}</p>}
      {creationUncertain && <p role="alert" className="text-sm">Order creation could not be confirmed. Check My orders before trying again. Do not create another order until its status is clear.</p>}
      {(creationUncertain || createdOrderId) && (
        <p className="text-sm"><Link className="underline" href={createdOrderId ? "/protected/orders/" + createdOrderId : "/protected/orders"}>
          {createdOrderId ? "Open created order" : "My orders"}
        </Link></p>
      )}
    </div>
  );
}
