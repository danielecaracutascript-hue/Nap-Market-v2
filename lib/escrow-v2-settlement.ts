import * as bitcoin from "bitcoinjs-lib";

import type { EscrowParticipants } from "./escrow-v2";
import { deriveEscrowV2WitnessScript } from "./escrow-v2-script";

export type EscrowV2SettlementOutput = Readonly<{
  address: string;
  valueSats: bigint;
}>;

export type VerifyEscrowV2SettlementArgs = Readonly<{
  psbtBase64: string;
  participants: EscrowParticipants;
  escrowIndex: number;
  expectedTxid: string;
  expectedVout: number;
  expectedWitnessScript: Uint8Array;
  expectedInputSats: bigint;
  expectedOutputs: readonly EscrowV2SettlementOutput[];
  maxFeeSats: bigint;
  network: "regtest" | "signet";
}>;

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function requireCondition(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function bitcoinNetwork(network: "regtest" | "signet"): bitcoin.Network {
  return network === "regtest" ? bitcoin.networks.regtest : bitcoin.networks.testnet;
}

/**
 * Validates all immutable properties of a V2 settlement PSBT before either
 * participant signs it. This function never signs, finalizes, broadcasts or
 * contacts Bitcoin Core.
 */
export function verifyEscrowV2Settlement(
  args: VerifyEscrowV2SettlementArgs,
): { feeSats: bigint } {
  const network = bitcoinNetwork(args.network);
  const psbt = bitcoin.Psbt.fromBase64(args.psbtBase64, { network });

  requireCondition(psbt.inputCount === 1, "Escrow V2 settlement requires exactly one input");
  requireCondition(psbt.txOutputs.length === args.expectedOutputs.length, "Unexpected settlement output count");
  requireCondition(args.expectedOutputs.length >= 1 && args.expectedOutputs.length <= 2, "Invalid settlement output count");
  requireCondition(args.expectedInputSats > BigInt(0) && args.maxFeeSats >= BigInt(0), "Invalid settlement amounts");
  requireCondition(/^[0-9a-fA-F]{64}$/.test(args.expectedTxid), "Invalid expected escrow TXID");
  requireCondition(Number.isSafeInteger(args.expectedVout) && args.expectedVout >= 0, "Invalid expected escrow VOUT");

  const txInput = psbt.txInputs[0];
  const actualTxid = Buffer.from(txInput.hash).reverse().toString("hex");
  requireCondition(actualTxid.toLowerCase() === args.expectedTxid.toLowerCase(), "Unexpected escrow TXID");
  requireCondition(txInput.index === args.expectedVout, "Unexpected escrow VOUT");

  const input = psbt.data.inputs[0];
  requireCondition(!input.finalScriptWitness && !input.finalScriptSig, "Escrow V2 settlement PSBT is already finalized");
  requireCondition(!!input.witnessUtxo && !!input.witnessScript, "Incomplete escrow settlement input");
  requireCondition(
    input.sighashType === undefined || input.sighashType === bitcoin.Transaction.SIGHASH_ALL,
    "Unsupported settlement sighash type",
  );

  const witnessScript = deriveEscrowV2WitnessScript(args.participants, args.escrowIndex);
  requireCondition(hex(witnessScript) === hex(args.expectedWitnessScript), "Authorized settlement script mismatch");
  requireCondition(hex(input.witnessScript!) === hex(witnessScript), "PSBT witness script mismatch");
  const lockingScript = bitcoin.script.compile([bitcoin.opcodes.OP_0, bitcoin.crypto.sha256(witnessScript)]);
  requireCondition(hex(input.witnessUtxo!.script) === hex(lockingScript), "PSBT locking script mismatch");
  requireCondition(input.witnessUtxo!.value === args.expectedInputSats, "PSBT escrow input amount mismatch");

  const expected = new Map<string, bigint>();
  for (const output of args.expectedOutputs) {
    requireCondition(output.valueSats > BigInt(0), "Invalid expected settlement output amount");
    const script = bitcoin.address.toOutputScript(output.address, network);
    const key = hex(script);
    requireCondition(!expected.has(key), "Duplicate expected settlement destination");
    expected.set(key, output.valueSats);
  }

  let outputsTotal = BigInt(0);
  const seen = new Set<string>();
  for (const output of psbt.txOutputs) {
    const key = hex(output.script);
    requireCondition(!seen.has(key), "Duplicate settlement output destination");
    seen.add(key);
    requireCondition(expected.get(key) === output.value, "Unexpected settlement output");
    outputsTotal += output.value;
  }
  requireCondition(seen.size === expected.size, "Missing settlement output");

  const feeSats = args.expectedInputSats - outputsTotal;
  requireCondition(feeSats >= BigInt(0) && feeSats <= args.maxFeeSats, "Settlement fee exceeds authorized limit");
  return { feeSats };
}
