"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function ProfilePage() {
  const supabase = createClient();
  const [handle, setHandle] = useState("");
  const [country, setCountry] = useState("");
  const [sellerType, setSellerType] = useState("private");
  const [businessName, setBusinessName] = useState("");
  const [vatId, setVatId] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveUncertain, setSaveUncertain] = useState(false);
  const saveRunning = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
      const { data: auth, error: authError } = await supabase.auth.getUser();
      if (cancelled) return;
      if (authError || !auth.user) throw new Error("Sign in again to load your profile.");
      const { data, error } = await supabase
        .from("profiles")
        .select("handle, country, seller_type, business_info")
        .eq("id", auth.user.id)
        .maybeSingle();
      if (cancelled) return;
      if (error) throw new Error("Your profile could not be loaded. Reload before editing it.");
      if (data) {
        setHandle(data.handle);
        setCountry(data.country);
        setSellerType(data.seller_type);
        setBusinessName(data.business_info?.business_name ?? "");
        setVatId(data.business_info?.vat_id ?? "");
      }
      setOwnerId(auth.user.id);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Your profile could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (saveRunning.current || loading || loadError || !ownerId || saveUncertain) return;
    saveRunning.current = true;
    setSaving(true);
    setMessage("");
    let outcomeUncertain = false;
    try {
    const { data: auth, error: authError } = await supabase.auth.getUser();
    if (authError || !auth.user || auth.user.id !== ownerId) {
      setLoadError("Your session changed or could not be verified. Reload your profile before saving.");
      return;
    }
    const row = {
      id: ownerId,
      handle: handle.trim().toLowerCase(),
      country: country.trim().toUpperCase(),
      seller_type: sellerType,
      business_info:
        sellerType === "professional"
          ? { business_name: businessName.trim(), vat_id: vatId.trim() }
          : null,
    };
    const { data, error } = await supabase.from("profiles").upsert(row).select("id").single();
    if (error) {
      if (/^(22|23|28|42|P0)[0-9A-Z]{3}$/.test(error.code ?? "")) {
        setMessage("Error: " + error.message);
        return;
      }
      throw new Error("Save outcome unavailable");
    }
    if (data?.id !== ownerId) throw new Error("Save response invalid");
    setMessage("Profile saved.");
    } catch {
      outcomeUncertain = true;
      setSaveUncertain(true);
      setMessage("Saving could not be confirmed. Reload your profile and check the saved values before trying again.");
    } finally {
      if (!outcomeUncertain) saveRunning.current = false;
      setSaving(false);
    }
  }

  if (loading) return <p className="p-6">Loading...</p>;
  if (loadError) return (
    <div className="space-y-3 p-6 text-sm">
      <p role="alert">{loadError}</p>
      <form action="/protected/profile" method="get"><button className="underline">Reload profile</button></form>
      <Link className="underline" href="/auth/login">Sign in again</Link>
    </div>
  );

  const field = "w-full rounded border bg-transparent px-3 py-2";

  return (
    <div className="mx-auto w-full max-w-md space-y-4 p-6">
      <h1 className="text-2xl font-bold">Your profile</h1>
      <form onSubmit={save} className="space-y-4">
        <fieldset disabled={saving || saveUncertain} className="min-w-0 space-y-4">
        <label className="block">
          <span className="text-sm">Public name (3-20 characters: a-z, 0-9, _)</span>
          <input className={field} value={handle} onChange={(e) => setHandle(e.target.value)} required pattern="[a-zA-Z0-9_]{3,20}" />
        </label>
        <label className="block">
          <span className="text-sm">Country (2-letter code, e.g. IT)</span>
          <input className={field} value={country} onChange={(e) => setCountry(e.target.value)} required maxLength={2} minLength={2} />
        </label>
        <label className="block">
          <span className="text-sm">I sell as</span>
          <select className={field} value={sellerType} onChange={(e) => setSellerType(e.target.value)}>
            <option value="private">A private individual</option>
            <option value="professional">A business or professional</option>
          </select>
        </label>
        {sellerType === "professional" && (
          <>
            <label className="block">
              <span className="text-sm">Business name</span>
              <input className={field} value={businessName} onChange={(e) => setBusinessName(e.target.value)} required />
            </label>
            <label className="block">
              <span className="text-sm">VAT number</span>
              <input className={field} value={vatId} onChange={(e) => setVatId(e.target.value)} required />
            </label>
          </>
        )}
        <button type="submit" className="rounded bg-foreground px-4 py-2 text-background">{saving ? "Saving..." : "Save profile"}</button>
        </fieldset>
      </form>
      {message && <p role={saveUncertain ? "alert" : "status"} className="text-sm">{message}</p>}
      {saveUncertain && <form action="/protected/profile" method="get"><button className="underline">Reload profile</button></form>}
      <p className="text-sm"><Link className="underline" href="/protected/listings">Back to listings</Link></p>
    </div>
  );
}
