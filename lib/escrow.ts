/* eslint-disable @typescript-eslint/no-explicit-any */
// Funzioni condivise tra browser e server per il rilascio dei fondi.

const NETWORK_NAME: string = process.env.NEXT_PUBLIC_BITCOIN_NETWORK ?? "testnet";

async function deps() {
  const btcm: any = await import("bitcoinjs-lib");
  const dm: any = await import("@bitcoinerlab/descriptors");
  const bip39m: any = await import("bip39");
  const btc = btcm.networks ? btcm : btcm.default;
  const lib = dm.BIP32 ? dm : dm.default;
  const bip39 = bip39m.mnemonicToSeedSync ? bip39m : bip39m.default;
  const network = NETWORK_NAME === "signet" ? btc.networks.testnet : btc.networks[NETWORK_NAME];
  if (!network) throw new Error("Unsupported Bitcoin network configuration");
  return { btc, lib, bip39, network };
}

export const hexOf = (u: Uint8Array) =>
  Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("");

const bareKey = (x: string) => x.replace(/^\[[^\]]*\]/, "");

// Il descrittore salvato dal server usa la forma di Bitcoin Core (con "h" e checksum);
// la libreria vuole la forma con l'apostrofo, solo dentro le parentesi quadre.
export function libDescriptor(d: string) {
  return d
    .replace(/#[a-z0-9]{8}$/i, "")
    .replace(/\[[^\]]*\]/g, (m) => m.replace(/(\d)h/g, "$1'"));
}

type Amounts = {
  price_sats: number | string;
  buyer_commission_sats: number | string;
  seller_commission_sats: number | string;
};

// L'escrow contiene prezzo + commissione del compratore.
// Al rilascio la piattaforma riceve le due commissioni, il venditore il resto meno la commissione di rete.
export function releaseAmounts(o: Amounts) {
  const price = Number(o.price_sats);
  const buyerFee = Number(o.buyer_commission_sats);
  const sellerFee = Number(o.seller_commission_sats);
  return { escrowTotal: price + buyerFee, platform: buyerFee + sellerFee };
}

export async function derivePubkey(xpubWithOrigin: string, branch: number, index: number): Promise<Uint8Array> {
  const { lib, network } = await deps();
  return lib.BIP32.fromBase58(bareKey(xpubWithOrigin), network).derive(branch).derive(index).publicKey;
}

// Indirizzo di incasso: ramo 3 della chiave dell'utente, uno per ordine.
export async function payoutAddress(xpubWithOrigin: string, branch: number, index: number): Promise<string> {
  const { btc, network } = await deps();
  const pubkey = await derivePubkey(xpubWithOrigin, branch, index);
  return btc.payments.p2wpkh({ pubkey, network }).address as string;
}

export async function buildReleasePsbt(a: {
  descriptor: string;
  index: number;
  txHex: string;
  vout: number;
  sellerXpub: string;
  platformXpub: string;
  sellerAddress: string;
  platformAddress: string;
  sellerAmount: number;
  platformAmount: number;
}): Promise<string> {
  const { lib, network } = await deps();
  const sellerPub = await derivePubkey(a.sellerXpub, 0, a.index);
  const platformPub = await derivePubkey(a.platformXpub, 0, a.index);
  const psbt = new lib.Psbt({ network });
  const out = new lib.Output({
    descriptor: libDescriptor(a.descriptor),
    index: a.index,
    network,
    signersPubKeys: [platformPub, sellerPub],
  });
  out.updatePsbtAsInput({ psbt, txHex: a.txHex, vout: a.vout });
  psbt.addOutput({ address: a.sellerAddress, value: BigInt(a.sellerAmount) });
  psbt.addOutput({ address: a.platformAddress, value: BigInt(a.platformAmount) });
  return psbt.toBase64();
}

// Controllo fatto da CHI FIRMA prima di firmare (browser del venditore e regola della piattaforma).
export async function verifyReleasePsbt(a: {
  psbtBase64: string;
  fundingTxid: string;
  fundingVout: number;
  escrowTotal: number;
  platformAmount: number;
  sellerAddress: string;
  platformAddress: string;
  maxFee: number;
}): Promise<{ ok: boolean; reason?: string; fee?: number; sellerAmount?: number }> {
  try {
    const { btc, network } = await deps();
    const psbt = btc.Psbt.fromBase64(a.psbtBase64, { network });
    if (psbt.txInputs.length !== 1) return { ok: false, reason: "unexpected number of inputs" };
    const inp = psbt.txInputs[0];
    const txid = hexOf(Uint8Array.from(inp.hash).reverse());
    if (txid !== a.fundingTxid || inp.index !== a.fundingVout) {
      return { ok: false, reason: "the input is not this order's escrow payment" };
    }
    const data = psbt.data.inputs[0];
    let inValue: bigint | null = null;
    if (data.witnessUtxo) inValue = BigInt(data.witnessUtxo.value);
    else if (data.nonWitnessUtxo) {
      const tx = btc.Transaction.fromBuffer(data.nonWitnessUtxo);
      inValue = BigInt(tx.outs[inp.index].value);
    }
    if (inValue === null) return { ok: false, reason: "missing input amount" };
    if (inValue !== BigInt(a.escrowTotal)) {
      return { ok: false, reason: "escrow amount " + inValue + " differs from the expected " + a.escrowTotal };
    }
    const outs = psbt.txOutputs;
    if (outs.length !== 2) return { ok: false, reason: "unexpected number of outputs" };
    const addrOf = (o: any) => o.address ?? btc.address.fromOutputScript(o.script, network);
    const platformOut = outs.find((o: any) => addrOf(o) === a.platformAddress);
    const sellerOut = outs.find((o: any) => addrOf(o) === a.sellerAddress);
    if (!platformOut || !sellerOut || platformOut === sellerOut) {
      return { ok: false, reason: "the outputs are not the expected ones" };
    }
    if (BigInt(platformOut.value) !== BigInt(a.platformAmount)) {
      return { ok: false, reason: "the platform commission is not the expected one" };
    }
    const fee = Number(inValue - BigInt(platformOut.value) - BigInt(sellerOut.value));
    if (fee < 0 || fee > a.maxFee) return { ok: false, reason: "the network fee " + fee + " sat is out of range" };
    return { ok: true, fee, sellerAmount: Number(sellerOut.value) };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

// Impronta della transazione (senza le firme): serve a confermare che e' quella preparata.
export async function txFingerprint(psbtBase64: string): Promise<string> {
  const { btc, network } = await deps();
  const psbt = btc.Psbt.fromBase64(psbtBase64, { network });
  return JSON.stringify({
    v: psbt.version,
    l: psbt.locktime,
    i: psbt.txInputs.map((x: any) => [hexOf(Uint8Array.from(x.hash)), x.index, x.sequence]),
    o: psbt.txOutputs.map((x: any) => [hexOf(Uint8Array.from(x.script)), x.value.toString()]),
  });
}

export async function sigPubkeys(psbtBase64: string): Promise<string[]> {
  const { btc, network } = await deps();
  const psbt = btc.Psbt.fromBase64(psbtBase64, { network });
  const sigs = psbt.data.inputs[0].partialSig ?? [];
  return sigs.map((s: any) => hexOf(s.pubkey));
}

// Firma con la chiave segreta e TIENE solo le firme delle chiavi indicate.
export async function signWith(a: {
  mnemonic: string;
  psbtBase64: string;
  keepPubkeys: Uint8Array[];
}): Promise<string> {
  const { btc, lib, bip39, network } = await deps();
  const phrase = a.mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
  const master = lib.BIP32.fromSeed(bip39.mnemonicToSeedSync(phrase), network);
  const psbt = btc.Psbt.fromBase64(a.psbtBase64, { network });
  lib.signers.signBIP32({ psbt, masterNode: master });
  const keep = new Set(a.keepPubkeys.map(hexOf));
  const inp = psbt.data.inputs[0];
  inp.partialSig = (inp.partialSig ?? []).filter((s: any) => keep.has(hexOf(s.pubkey)));
  return psbt.toBase64();
}

// ---------------------------------------------------------------- RIMBORSO

export type RefundKind = "return" | "dispute" | "no_shipment";

// Il motivo del rimborso si ricava dalla cronologia scritta dal database.
export function refundKindFromEvents(events: { type: string; data?: any }[]): RefundKind | null {
  // Regola commerciale confermata il 30/10/2026: se nasce da un reso,
  // la commissione buyer resta trattenuta anche dopo una disputa vinta dal buyer.
  // La precedenza del reso è intenzionale e non dipende dall'ordine degli eventi.
  if (events.some((e) => e.type === "return_requested")) return "return";
  if (events.some((e) => e.type === "dispute_decided" && e.data?.decision === "buyer")) return "dispute";
  if (events.some((e) => e.type === "no_shipment_refund")) return "no_shipment";
  return null;
}

// Reso per ripensamento: la commissione del compratore non viene restituita.
export function refundAmounts(o: Amounts, kind: RefundKind) {
  const buyerFee = Number(o.buyer_commission_sats);
  const escrowTotal = Number(o.price_sats) + buyerFee;
  return { escrowTotal, platform: kind === "return" ? buyerFee : 0 };
}

export async function buildRefundPsbt(a: {
  descriptor: string;
  index: number;
  txHex: string;
  vout: number;
  buyerXpub: string;
  platformXpub: string;
  buyerAddress: string;
  platformAddress: string;
  buyerAmount: number;
  platformAmount: number;
}): Promise<string> {
  const { lib, network } = await deps();
  const buyerPub = await derivePubkey(a.buyerXpub, 0, a.index); // Branch 0 per chiavi di firma nel descriptor
  const platformPub = await derivePubkey(a.platformXpub, 0, a.index); // Branch 0 per chiavi di firma nel descriptor
  const psbt = new lib.Psbt({ network });
  const out = new lib.Output({
    descriptor: libDescriptor(a.descriptor),
    index: a.index,
    network,
    signersPubKeys: [platformPub, buyerPub],
  });
  out.updatePsbtAsInput({ psbt, txHex: a.txHex, vout: a.vout });
  psbt.addOutput({ address: a.buyerAddress, value: BigInt(a.buyerAmount) });
  if (a.platformAmount > 0) {
    psbt.addOutput({ address: a.platformAddress, value: BigInt(a.platformAmount) });
  }
  return psbt.toBase64();
}

// Controllo fatto da CHI FIRMA (browser del compratore e regola della piattaforma).
export async function verifyRefundPsbt(a: {
  psbtBase64: string;
  fundingTxid: string;
  fundingVout: number;
  escrowTotal: number;
  platformAmount: number;
  buyerAddress: string;
  platformAddress: string;
  maxFee: number;
}): Promise<{ ok: boolean; reason?: string; fee?: number; buyerAmount?: number }> {
  try {
    const { btc, network } = await deps();
    const psbt = btc.Psbt.fromBase64(a.psbtBase64, { network });
    if (psbt.txInputs.length !== 1) return { ok: false, reason: "unexpected number of inputs" };
    const inp = psbt.txInputs[0];
    const txid = hexOf(Uint8Array.from(inp.hash).reverse());
    if (txid !== a.fundingTxid || inp.index !== a.fundingVout) {
      return { ok: false, reason: "the input is not this order's escrow payment" };
    }
    const data = psbt.data.inputs[0];
    let inValue: bigint | null = null;
    if (data.witnessUtxo) inValue = BigInt(data.witnessUtxo.value);
    else if (data.nonWitnessUtxo) {
      const tx = btc.Transaction.fromBuffer(data.nonWitnessUtxo);
      inValue = BigInt(tx.outs[inp.index].value);
    }
    if (inValue === null) return { ok: false, reason: "missing input amount" };
    if (inValue !== BigInt(a.escrowTotal)) {
      return { ok: false, reason: "escrow amount " + inValue + " differs from the expected " + a.escrowTotal };
    }
    const outs = psbt.txOutputs;
    const expectedCount = a.platformAmount > 0 ? 2 : 1;
    if (outs.length !== expectedCount) return { ok: false, reason: "unexpected number of outputs" };
    const addrOf = (o: any) => o.address ?? btc.address.fromOutputScript(o.script, network);
    const buyerOut = outs.find((o: any) => addrOf(o) === a.buyerAddress);
    if (!buyerOut) return { ok: false, reason: "the refund does not go to the expected buyer address" };
    let outSum = BigInt(buyerOut.value);
    if (a.platformAmount > 0) {
      const platformOut = outs.find((o: any) => addrOf(o) === a.platformAddress);
      if (!platformOut || platformOut === buyerOut) {
        return { ok: false, reason: "the platform output is not the expected one" };
      }
      if (BigInt(platformOut.value) !== BigInt(a.platformAmount)) {
        return { ok: false, reason: "the platform amount is not the expected one" };
      }
      outSum += BigInt(platformOut.value);
    }
    const fee = Number(inValue - outSum);
    if (fee < 0 || fee > a.maxFee) return { ok: false, reason: "the network fee " + fee + " sat is out of range" };
    return { ok: true, fee, buyerAmount: Number(buyerOut.value) };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

// ---------------------------------------------------------------- RIMBORSO


// Il motivo del rimborso si ricava dalla cronologia scritta dal database.

