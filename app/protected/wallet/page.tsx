"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  accountKey,
  createRecord,
  deleteRecord,
  isValidMnemonic,
  loadRecord,
  newMnemonic,
  normalize,
  saveRecord,
  unlock,
  type WalletRecord,
} from "@/lib/wallet";

type Stage = "loading" | "none" | "show" | "verify" | "restore" | "password" | "ready";

export default function WalletPage() {
  const supabase = createClient();
  const [stage, setStage] = useState<Stage>("loading");
  const [userId, setUserId] = useState("");
  const [rec, setRec] = useState<WalletRecord | null>(null);
  const [registered, setRegistered] = useState<string | null>(null);
  const [words, setWords] = useState<string[]>([]);
  const [wrote, setWrote] = useState(false);
  const [checkPos, setCheckPos] = useState<number[]>([]);
  const [checkAns, setCheckAns] = useState<string[]>(["", "", ""]);
  const [restoreText, setRestoreText] = useState("");
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [testPw, setTestPw] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadAll() {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) {
      setMessage("You must be signed in.");
      setStage("none");
      return;
    }
    setUserId(auth.user.id);
    const { data: p } = await supabase.from("profiles").select("wallet_xpub").eq("id", auth.user.id).maybeSingle();
    setRegistered(p?.wallet_xpub ?? null);
    const r = loadRecord(auth.user.id);
    setRec(r);
    setStage(r ? "ready" : "none");
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startCreate() {
    setMessage("");
    const m = await newMnemonic();
    const w = m.split(" ");
    const pos = Array.from({ length: w.length }, (_, i) => i)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3)
      .sort((a, b) => a - b);
    setWords(w);
    setCheckPos(pos);
    setCheckAns(["", "", ""]);
    setWrote(false);
    setStage("show");
  }

  function verifyWords(e: FormEvent) {
    e.preventDefault();
    const ok = checkPos.every((p, i) => checkAns[i].trim().toLowerCase() === words[p]);
    if (!ok) {
      setMessage("Those words do not match. Check your written copy.");
      return;
    }
    setMessage("");
    setStage("password");
  }

  async function restoreNext(e: FormEvent) {
    e.preventDefault();
    const m = normalize(restoreText);
    if (!(await isValidMnemonic(m))) {
      setMessage("This is not a valid recovery phrase.");
      return;
    }
    setWords(m.split(" "));
    setMessage("");
    setStage("password");
  }

  async function register(r: WalletRecord) {
    const { data, error } = await supabase
      .from("profiles")
      .update({ wallet_xpub: r.xpub })
      .eq("id", userId)
      .select("id");
    if (error) {
      setMessage("Could not register the public key: " + error.message);
      return;
    }
    if (!data || data.length === 0) {
      setMessage("Wallet saved on this device, but you have no profile yet. Create your profile, then press Register public key.");
      return;
    }
    setRegistered(r.xpub);
    setMessage("Public key registered in your profile.");
  }

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    setMessage("");
    if (pw1.length < 10) {
      setMessage("Use a password of at least 10 characters.");
      return;
    }
    if (pw1 !== pw2) {
      setMessage("The two passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const r = await createRecord(words.join(" "), pw1);
      saveRecord(userId, r);
      setRec(r);
      setWords([]);
      setRestoreText("");
      setPw1("");
      setPw2("");
      setStage("ready");
      await register(r);
    } catch (err) {
      setMessage("Error: " + (err as Error).message);
    }
    setBusy(false);
  }

  async function checkPassword(e: FormEvent) {
    e.preventDefault();
    if (!rec) return;
    setBusy(true);
    setMessage("");
    try {
      const m = await unlock(rec, testPw);
      const { fingerprint } = await accountKey(m);
      setMessage(
        fingerprint === rec.fingerprint
          ? "Password OK. The key matches fingerprint " + fingerprint + "."
          : "Password OK, but the fingerprint differs. Something is wrong."
      );
    } catch (err) {
      setMessage((err as Error).message);
    }
    setTestPw("");
    setBusy(false);
  }

  function removeFromDevice() {
    if (!window.confirm("This removes the wallet from this browser. You will need your 12 words to restore it. Continue?")) return;
    deleteRecord(userId);
    setRec(null);
    setMessage("Wallet removed from this device.");
    setStage("none");
  }

  const field = "w-full rounded border bg-transparent px-3 py-2";
  const btn = "rounded bg-foreground px-4 py-2 text-background disabled:opacity-50";
  const btnOutline = "rounded border px-4 py-2";

  if (stage === "loading") return <p className="p-6 text-sm">Loading...</p>;

  return (
    <div className="mx-auto w-full max-w-md space-y-4 p-6">
      <p className="text-sm"><Link className="underline" href="/protected/listings">Listings</Link></p>
      <h1 className="text-2xl font-bold">My wallet</h1>
      <p className="text-xs opacity-70">Test networks only. Your secret phrase never leaves this browser: the server only receives your public key.</p>

      {stage === "none" && (
        <div className="space-y-3 rounded border p-4 text-sm">
          <p>There is no wallet on this device.</p>
          <div className="flex gap-3">
            <button onClick={startCreate} className={btn}>Create a new wallet</button>
            <button onClick={() => { setMessage(""); setStage("restore"); }} className={btnOutline}>Restore from 12 words</button>
          </div>
        </div>
      )}

      {stage === "show" && (
        <div className="space-y-3 rounded border p-4 text-sm">
          <p className="font-semibold">Write these 12 words on paper, in order.</p>
          <p className="text-xs opacity-70">They are the only way to recover your funds. Anyone who has them can take your money. Do not take a screenshot and do not store them online.</p>
          <ol className="grid grid-cols-3 gap-2">
            {words.map((w, i) => (
              <li key={i} className="rounded border px-2 py-1 font-mono text-xs">{i + 1}. {w}</li>
            ))}
          </ol>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={wrote} onChange={(e) => setWrote(e.target.checked)} />
            <span>I wrote them down on paper</span>
          </label>
          <button disabled={!wrote} onClick={() => { setMessage(""); setStage("verify"); }} className={btn}>Continue</button>
        </div>
      )}

      {stage === "verify" && (
        <form onSubmit={verifyWords} className="space-y-3 rounded border p-4 text-sm">
          <p className="font-semibold">Check your backup</p>
          <p className="text-xs opacity-70">Type the words in these positions (from your paper copy).</p>
          {checkPos.map((p, i) => (
            <label key={p} className="block">
              <span>Word number {p + 1}</span>
              <input className={field} value={checkAns[i]} autoComplete="off"
                onChange={(e) => setCheckAns(checkAns.map((a, j) => (j === i ? e.target.value : a)))} required />
            </label>
          ))}
          <button type="submit" className={btn}>Verify</button>
        </form>
      )}

      {stage === "restore" && (
        <form onSubmit={restoreNext} className="space-y-3 rounded border p-4 text-sm">
          <p className="font-semibold">Restore from your recovery phrase</p>
          <textarea className={field} rows={3} placeholder="12 words separated by spaces" value={restoreText}
            onChange={(e) => setRestoreText(e.target.value)} required autoComplete="off" />
          <div className="flex gap-3">
            <button type="submit" className={btn}>Continue</button>
            <button type="button" onClick={() => setStage("none")} className={btnOutline}>Cancel</button>
          </div>
        </form>
      )}

      {stage === "password" && (
        <form onSubmit={savePassword} className="space-y-3 rounded border p-4 text-sm">
          <p className="font-semibold">Choose a password</p>
          <p className="text-xs opacity-70">It encrypts your wallet on this device. It cannot be recovered: if you forget it you will need your 12 words.</p>
          <input className={field} type="password" placeholder="Password (at least 10 characters)" value={pw1}
            onChange={(e) => setPw1(e.target.value)} required autoComplete="new-password" />
          <input className={field} type="password" placeholder="Repeat password" value={pw2}
            onChange={(e) => setPw2(e.target.value)} required autoComplete="new-password" />
          <button type="submit" disabled={busy} className={btn}>{busy ? "Encrypting..." : "Create wallet"}</button>
        </form>
      )}

      {stage === "ready" && rec && (
        <div className="space-y-4">
          <div className="space-y-2 rounded border p-4 text-sm">
            <p className="font-semibold">Wallet on this device</p>
            <p>Fingerprint: <span className="font-mono">{rec.fingerprint}</span></p>
            <p className="break-all font-mono text-xs">{rec.xpub}</p>
            <p>
              Public key in your profile:{" "}
              <b>{registered === rec.xpub ? "registered" : registered ? "a different key is registered" : "not registered"}</b>
            </p>
            {registered !== rec.xpub && (
              <div className="space-y-1">
                {registered && (
                  <p className="text-xs opacity-70">Warning: new orders will use this key. Keep access to your old key for orders already in progress.</p>
                )}
                <button onClick={() => register(rec)} className={btnOutline}>Register public key</button>
              </div>
            )}
          </div>

          <form onSubmit={checkPassword} className="space-y-2 rounded border p-4 text-sm">
            <p className="font-semibold">Check your password</p>
            <input className={field} type="password" placeholder="Password" value={testPw}
              onChange={(e) => setTestPw(e.target.value)} required autoComplete="current-password" />
            <button type="submit" disabled={busy} className={btn}>{busy ? "Checking..." : "Check"}</button>
          </form>

          <button onClick={removeFromDevice} className={btnOutline}>Remove wallet from this device</button>
        </div>
      )}

      {message && <p className="text-sm">{message}</p>}
    </div>
  );
}
