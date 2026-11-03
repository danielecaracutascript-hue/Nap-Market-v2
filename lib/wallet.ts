/* eslint-disable @typescript-eslint/no-explicit-any */
// Funzioni del portafoglio. Girano SOLO nel browser: le chiavi non escono da qui.

const PBKDF2_ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (u: Uint8Array) => btoa(String.fromCharCode(...Array.from(u)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const normalize = (m: string) => m.trim().toLowerCase().split(/\s+/).join(" ");

async function libs() {
  const bip39m: any = await import("bip39");
  const btc: any = await import("bitcoinjs-lib");
  const d: any = await import("@bitcoinerlab/descriptors");
  return {
    bip39: bip39m.mnemonicToSeedSync ? bip39m : bip39m.default,
    networks: btc.networks ?? btc.default?.networks,
    lib: d.BIP32 ? d : d.default,
  };
}

export type WalletRecord = {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ct: string;
  fingerprint: string;
  xpub: string;
  createdAt: string;
};

export async function newMnemonic(): Promise<string> {
  const { bip39 } = await libs();
  return bip39.generateMnemonic(128);
}

export async function isValidMnemonic(m: string): Promise<boolean> {
  const { bip39 } = await libs();
  return bip39.validateMnemonic(normalize(m));
}

// Chiave pubblica estesa del conto, nel formato che il database e il server si aspettano.
// Rete di prova (testnet/signet/regtest): percorso 84h/1h/0h.
export async function accountKey(mnemonic: string) {
  const { bip39, networks, lib } = await libs();
  const master = lib.BIP32.fromSeed(bip39.mnemonicToSeedSync(normalize(mnemonic)), networks.testnet);
  const fp = Array.from(master.fingerprint as Uint8Array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const acct = master.derivePath("m/84'/1'/0'");
  return { fingerprint: fp, xpub: `[${fp}/84h/1h/0h]${acct.neutered().toBase58()}` };
}

async function deriveAesKey(password: string, salt: Uint8Array, iterations: number) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password) as any, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as any, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function createRecord(mnemonic: string, password: string): Promise<WalletRecord> {
  const m = normalize(mnemonic);
  const { fingerprint, xpub } = await accountKey(m);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt, PBKDF2_ITERATIONS);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as any }, key, enc.encode(m) as any)
  );
  return {
    v: 1,
    kdf: "PBKDF2-SHA256",
    iterations: PBKDF2_ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ct),
    fingerprint,
    xpub,
    createdAt: new Date().toISOString(),
  };
}

export async function unlock(rec: WalletRecord, password: string): Promise<string> {
  try {
    const key = await deriveAesKey(password, fromB64(rec.salt), rec.iterations);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(rec.iv) as any }, key, fromB64(rec.ct) as any);
    return dec.decode(pt);
  } catch {
    throw new Error("Wrong password");
  }
}

const storageKey = (userId: string) => "marketplace-wallet-v1:" + userId;

export function loadRecord(userId: string): WalletRecord | null {
  try {
    const s = localStorage.getItem(storageKey(userId));
    return s ? (JSON.parse(s) as WalletRecord) : null;
  } catch {
    return null;
  }
}

export function saveRecord(userId: string, rec: WalletRecord) {
  localStorage.setItem(storageKey(userId), JSON.stringify(rec));
}

export function deleteRecord(userId: string) {
  localStorage.removeItem(storageKey(userId));
}
