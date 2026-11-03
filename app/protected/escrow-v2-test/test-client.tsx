"use client";

import { useEffect, useState } from "react";
import * as bitcoin from "bitcoinjs-lib";
import * as descriptors from "@bitcoinerlab/descriptors";

import { createClient } from "@/lib/supabase/client";
import { loadRecord, unlock, accountKey } from "@/lib/wallet";
import { signEscrowV2 } from "@/lib/escrow-v2-sign";
import { deriveEscrowV2WitnessScript } from "@/lib/escrow-v2-script";
import type { EscrowParticipants } from "@/lib/escrow-v2";

const INDEX = 1002;
const TXID =
  "1c0e89bc86baa23c9e209dc02833a48b5b930f88aebaaf6243b81b8cd75847ee";
const DESTINATION =
  "bcrt1quym2crkj3zvcnchn3ne6e9kx2yj3rw5j8hatsr";

const INPUT_SATS = BigInt(100000);
const OUTPUT_SATS = BigInt(99000);
const MAX_FEE_SATS = BigInt(1000);

function parseParticipants(descriptor: string): EscrowParticipants {
  const keys = descriptor.match(
    /\[[0-9a-fA-F]{8}\/84h\/1h\/0h\]tpub[1-9A-HJ-NP-Za-km-z]+/g
  );

  if (!keys || keys.length !== 3) {
    throw new Error("Expected three public account keys");
  }

  if (!keys[0].startsWith("[c0458014/") ||
      !keys[1].startsWith("[f67e17b5/") ||
      !keys[2].startsWith("[79ba1c42/")) {
    throw new Error("Unexpected participant fingerprints");
  }

  return {
    buyerXpub: keys[0],
    sellerXpub: keys[1],
    platformEscrowXpub: keys[2],
  };
}

export default function EscrowV2TestClient() {
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [descriptor, setDescriptor] = useState("");
  const [psbtText, setPsbtText] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? "");
    });
  }, []);

  async function sign() {
    setBusy(true);
    setMessage("");

    try {
      if (!["localhost", "127.0.0.1"].includes(window.location.hostname)) {
        throw new Error("Localhost only");
      }

      if (!userId) throw new Error("Not authenticated");

      const participants = parseParticipants(descriptor);

      const buyerAccount = descriptors.BIP32.fromBase58(
        participants.buyerXpub.replace(
          /^\[[0-9a-fA-F]{8}\/84h\/1h\/0h\]/,
          ""
        ),
        bitcoin.networks.testnet
      );

      const expectedPubkey = buyerAccount
        .derive(0)
        .derive(INDEX)
        .publicKey;

      const expectedWitnessScript = deriveEscrowV2WitnessScript(
        participants,
        INDEX
      );

      const rec = loadRecord(userId);
      if (!rec) throw new Error("Buyer wallet not found");

      const mnemonic = await unlock(rec, password);
      setPassword("");

      const account = await accountKey(mnemonic);

      if (account.fingerprint !== "c0458014") {
        throw new Error("Wrong buyer wallet");
      }

      if (account.fingerprint !== rec.fingerprint) {
        throw new Error("Wallet fingerprint mismatch");
      }

      if (account.xpub !== participants.buyerXpub) {
        throw new Error("Buyer account xpub mismatch");
      }

      const signed = await signEscrowV2({
        mnemonic,
        psbtBase64: psbtText.trim(),
        expectedPubkey,
        participants,
        escrowIndex: INDEX,
        expectedTxid: TXID,
        expectedVout: 0,
        expectedWitnessScript,
        expectedInputSats: INPUT_SATS,
        expectedDestination: DESTINATION,
        expectedOutputSats: OUTPUT_SATS,
        maxFeeSats: MAX_FEE_SATS,
        network: "regtest",
      });

      const result = bitcoin.Psbt.fromBase64(signed, {
        network: bitcoin.networks.regtest,
      });

      const signatures = result.data.inputs[0].partialSig ?? [];

      if (signatures.length !== 1) {
        throw new Error("Expected exactly one partial signature");
      }

      if (
        result.data.inputs[0].finalScriptWitness ||
        result.data.inputs[0].finalScriptSig
      ) {
        throw new Error("PSBT was unexpectedly finalized");
      }

      setMessage(
        "PASS: Buyer ECDSA signature verified. " +
        "Partial signatures: 1. " +
        "PSBT not finalized. Nothing broadcast."
      );
    } catch (err) {
      setMessage("ERROR: " + (err as Error).message);
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl space-y-5 p-6">
      <h1 className="text-2xl font-bold">
        Escrow V2 — Regtest Signing
      </h1>

      <p>
        Local signing test. No transaction broadcast.
      </p>

      <p>User: {userId ? "Authenticated" : "Not authenticated"}</p>

      <textarea
        value={descriptor}
        onChange={(e) => setDescriptor(e.target.value)}
        placeholder="Paste public descriptor"
        rows={5}
        className="w-full rounded border p-3"
      />

      <textarea
        value={psbtText}
        onChange={(e) => setPsbtText(e.target.value)}
        placeholder="Paste unsigned PSBT Base64"
        rows={5}
        className="w-full rounded border p-3"
      />

      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Buyer wallet password"
        autoComplete="off"
        className="w-full rounded border p-3"
      />

      <button
        type="button"
        disabled={busy || !userId || !password || !descriptor || !psbtText}
        onClick={sign}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {busy ? "Signing..." : "Sign Escrow V2 — Regtest"}
      </button>

      <p role="status">{message}</p>
    </main>
  );
}
