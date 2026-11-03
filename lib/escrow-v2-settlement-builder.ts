import "server-only";

import * as bitcoin from "bitcoinjs-lib";
import * as descriptors from "@bitcoinerlab/descriptors";

import type { EscrowParticipants } from "./escrow-v2";
import type { EscrowV2SettlementOutput } from "./escrow-v2-settlement";
import { deriveEscrowV2WitnessScript } from "./escrow-v2-script";

export type BuildEscrowV2SettlementArgs = Readonly<{
  participants: EscrowParticipants;
  escrowIndex: number;
  fundingTxHex: string;
  fundingVout: number;
  outputs: readonly EscrowV2SettlementOutput[];
  network: "regtest" | "signet";
}>;

function networkFor(value: "regtest" | "signet"): bitcoin.Network {
  return value === "regtest" ? bitcoin.networks.regtest : bitcoin.networks.testnet;
}

function account(value: string): { fingerprint: Buffer; xpub: string } {
  const match = value.match(/^\[([0-9a-fA-F]{8})\/84h\/1h\/0h\](tpub[1-9A-HJ-NP-Za-km-z]{100,120})$/);
  if (!match) throw new Error("Invalid escrow participant public key");
  return { fingerprint: Buffer.from(match[1], "hex"), xpub: match[2] };
}

/**
 * Builds an unsigned, one-input PSBT for the immutable V2 escrow UTXO. It
 * performs no signing, finalization, network call or database write.
 */
export function buildEscrowV2Settlement(
  args: BuildEscrowV2SettlementArgs,
): { psbtBase64: string; txid: string; inputSats: bigint; witnessScript: Uint8Array } {
  if (!Number.isSafeInteger(args.escrowIndex) || args.escrowIndex < 0 || args.escrowIndex >= 0x80000000) {
    throw new Error("Invalid escrow derivation index");
  }
  if (!Number.isSafeInteger(args.fundingVout) || args.fundingVout < 0) {
    throw new Error("Invalid funding VOUT");
  }
  if (args.outputs.length < 1 || args.outputs.length > 2) throw new Error("Invalid settlement output count");

  const network = networkFor(args.network);
  const funding = bitcoin.Transaction.fromHex(args.fundingTxHex);
  const previousOutput = funding.outs[args.fundingVout];
  if (!previousOutput) throw new Error("Funding output does not exist");
  const witnessScript = deriveEscrowV2WitnessScript(args.participants, args.escrowIndex);
  const lockingScript = bitcoin.script.compile([bitcoin.opcodes.OP_0, bitcoin.crypto.sha256(witnessScript)]);
  if (Buffer.from(previousOutput.script).toString("hex") !== Buffer.from(lockingScript).toString("hex")) {
    throw new Error("Funding output does not match the Escrow V2 script");
  }

  const entries = [args.participants.buyerXpub, args.participants.sellerXpub, args.participants.platformEscrowXpub]
    .map(account)
    .map(({ fingerprint, xpub }) => {
      const pubkey = descriptors.BIP32.fromBase58(xpub, bitcoin.networks.testnet)
        .derive(0).derive(args.escrowIndex).publicKey;
      return { masterFingerprint: fingerprint, path: `m/84'/1'/0'/0/${args.escrowIndex}`, pubkey };
    });

  const psbt = new bitcoin.Psbt({ network });
  psbt.addInput({
    hash: funding.getId(), index: args.fundingVout,
    witnessUtxo: { script: Buffer.from(previousOutput.script), value: previousOutput.value },
    witnessScript: Buffer.from(witnessScript), bip32Derivation: entries,
  });
  for (const output of args.outputs) {
    if (output.valueSats <= BigInt(0)) throw new Error("Invalid settlement output amount");
    psbt.addOutput({ address: output.address, value: output.valueSats });
  }
  return { psbtBase64: psbt.toBase64(), txid: funding.getId(), inputSats: previousOutput.value, witnessScript };
}
