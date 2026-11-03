"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from "react";

const hex = (u: Uint8Array) => Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("");

async function load() {
  const bip39: any = await import("bip39");
  const btc: any = await import("bitcoinjs-lib");
  const lib: any = await import("@bitcoinerlab/descriptors");
  return {
    bip39: bip39.mnemonicToSeedSync ? bip39 : bip39.default,
    networks: btc.networks ?? btc.default?.networks,
    lib: lib.Output ? lib : lib.default,
  };
}

export default function WalletTestPage() {
  const [mnemonic, setMnemonic] = useState("");
  const [outKey, setOutKey] = useState("");
  const [descriptor, setDescriptor] = useState("");
  const [outAddr, setOutAddr] = useState("");
  const [signMnemonic, setSignMnemonic] = useState("");
  const [psbtIn, setPsbtIn] = useState("");
  const [psbtOut, setPsbtOut] = useState("");
  const [info, setInfo] = useState("");

  async function testKey() {
    try {
      const { bip39, networks, lib } = await load();
      const master = lib.BIP32.fromSeed(bip39.mnemonicToSeedSync(mnemonic.trim()), networks.regtest);
      const acct = master.derivePath("m/84'/1'/0'");
      setOutKey("[" + hex(master.fingerprint) + "/84'/1'/0']" + acct.neutered().toBase58());
    } catch (e) {
      setOutKey("ERROR: " + (e as Error).message);
    }
  }

  async function testAddresses() {
    try {
      const { networks, lib } = await load();
      const lines: string[] = [];
      for (let i = 0; i < 3; i++) {
        const out = new lib.Output({ descriptor: descriptor.trim(), index: i, network: networks.regtest });
        lines.push(i + "  " + out.getAddress());
      }
      setOutAddr(lines.join("\n"));
    } catch (e) {
      setOutAddr("ERROR: " + (e as Error).message);
    }
  }

  async function doSign() {
    try {
      const { bip39, networks, lib } = await load();
      const network = networks.regtest;
      const master = lib.BIP32.fromSeed(bip39.mnemonicToSeedSync(signMnemonic.trim()), network);
      const psbt = lib.Psbt.fromBase64(psbtIn.trim(), { network });
      lib.signers.signBIP32({ psbt, masterNode: master });
      const sigs = psbt.data.inputs[0].partialSig ? psbt.data.inputs[0].partialSig.length : 0;
      setPsbtOut(psbt.toBase64());
      setInfo("Signed in the browser. Signatures in the input: " + sigs);
    } catch (e) {
      setInfo("ERROR: " + (e as Error).message);
    }
  }

  const box = "w-full rounded border bg-transparent px-3 py-2 font-mono text-xs";
  const btn = "rounded bg-foreground px-3 py-1 text-sm text-background";

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">Browser signing test (development only)</h1>
      <p className="text-sm">Use test keys only. Never paste a real seed phrase here.</p>

      <section className="space-y-2 rounded border p-4">
        <h2 className="font-semibold">Test 1: account public key</h2>
        <textarea className={box} rows={2} placeholder="Test seed phrase (12 words)" value={mnemonic} onChange={(e) => setMnemonic(e.target.value)} />
        <button className={btn} onClick={testKey}>Derive public key</button>
        <pre className="whitespace-pre-wrap break-all text-xs">{outKey}</pre>
      </section>

      <section className="space-y-2 rounded border p-4">
        <h2 className="font-semibold">Test 2: escrow addresses from the descriptor</h2>
        <textarea className={box} rows={4} placeholder="Escrow descriptor (public keys only)" value={descriptor} onChange={(e) => setDescriptor(e.target.value)} />
        <button className={btn} onClick={testAddresses}>Derive addresses</button>
        <pre className="whitespace-pre-wrap break-all text-xs">{outAddr}</pre>
      </section>

      <section className="space-y-2 rounded border p-4">
        <h2 className="font-semibold">Test 3: sign a transaction (PSBT)</h2>
        <textarea className={box} rows={2} placeholder="Signer seed phrase (test key)" value={signMnemonic} onChange={(e) => setSignMnemonic(e.target.value)} />
        <textarea className={box} rows={4} placeholder="PSBT to sign (base64)" value={psbtIn} onChange={(e) => setPsbtIn(e.target.value)} />
        <button className={btn} onClick={doSign}>Sign</button>
        <p className="text-sm">{info}</p>
        {psbtOut && (
          <>
            <textarea className={box} rows={4} readOnly value={psbtOut} />
            <button className={btn} onClick={() => navigator.clipboard.writeText(psbtOut)}>Copy signed PSBT</button>
          </>
        )}
      </section>
    </div>
  );
}
