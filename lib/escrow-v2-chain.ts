import "server-only";

import * as bitcoin from "bitcoinjs-lib";

import { rpc } from "./bitcoin";
import type { EscrowParticipants } from "./escrow-v2";
import { deriveEscrowV2WitnessScript } from "./escrow-v2-script";

export type VerifyEscrowV2UtxoArgs = {
  network: "regtest" | "signet";
  txid: string;
  vout: number;
  expectedSats: bigint;
  participants: EscrowParticipants;
  escrowIndex: number;
  psbtBase64: string;
};

type BlockchainInfo = {
  chain: string;
};

type UtxoInfo = {
  bestblock: string;
  confirmations: number;
  value: number;
  scriptPubKey: {
    hex: string;
    address?: string;
  };
  coinbase: boolean;
};

function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

export async function verifyEscrowV2Utxo(
  args: VerifyEscrowV2UtxoArgs
): Promise<{
  verified: true;
  confirmations: number;
  address: string;
  amountSats: bigint;
}> {
  const {
    network,
    txid,
    vout,
    expectedSats,
    participants,
    escrowIndex,
    psbtBase64,
  } = args;

  if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
    throw new Error("Invalid escrow TXID");
  }

  if (!Number.isSafeInteger(vout) || vout < 0) {
    throw new Error("Invalid escrow VOUT");
  }

  if (expectedSats <= BigInt(0)) {
    throw new Error("Invalid escrow amount");
  }

  // Verify node network.
  const blockchain = await rpc<BlockchainInfo>(
    "getblockchaininfo"
  );

  if (blockchain.chain !== network) {
    throw new Error(
      `Bitcoin network mismatch: expected ${network}`
    );
  }

  // Read the actual unspent output from Bitcoin Core.
  const utxo = await rpc<UtxoInfo | null>(
    "gettxout",
    [txid, vout, true]
  );

  if (!utxo) {
    throw new Error(
      "Escrow UTXO does not exist or has already been spent"
    );
  }

  if (!Number.isInteger(utxo.confirmations) ||
      utxo.confirmations < 1) {
    throw new Error("Escrow UTXO is not confirmed");
  }

  // Convert BTC to satoshis.
  const actualSats = BigInt(
    Math.round(utxo.value * 100000000)
  );

  if (actualSats !== expectedSats) {
    throw new Error("Escrow UTXO amount mismatch");
  }

  // Reconstruct the authorized 2-of-3 script.
  const witnessScript = deriveEscrowV2WitnessScript(
    participants,
    escrowIndex
  );

  const lockingScript = bitcoin.script.compile([
    bitcoin.opcodes.OP_0,
    bitcoin.crypto.sha256(witnessScript),
  ]);

  if (
    utxo.scriptPubKey.hex.toLowerCase() !==
    toHex(lockingScript)
  ) {
    throw new Error("Escrow UTXO script mismatch");
  }

  const btcNetwork =
    network === "regtest"
      ? bitcoin.networks.regtest
      : bitcoin.networks.testnet;

  const address = bitcoin.address.fromOutputScript(
    lockingScript,
    btcNetwork
  );

  // Verify PSBT against the independently checked UTXO.
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, {
    network: btcNetwork,
  });

  if (psbt.inputCount !== 1) {
    throw new Error("Unexpected PSBT input count");
  }

  const input = psbt.txInputs[0];

  const inputTxid = Buffer.from(input.hash)
    .reverse()
    .toString("hex");

  if (
    inputTxid.toLowerCase() !== txid.toLowerCase() ||
    input.index !== vout
  ) {
    throw new Error("PSBT outpoint mismatch");
  }

  const psbtInput = psbt.data.inputs[0];

  if (!psbtInput.witnessUtxo ||
      !psbtInput.witnessScript) {
    throw new Error("Incomplete escrow PSBT");
  }

  if (
    psbtInput.witnessUtxo.value !== expectedSats ||
    toHex(psbtInput.witnessUtxo.script) !==
      toHex(lockingScript) ||
    toHex(psbtInput.witnessScript) !==
      toHex(witnessScript)
  ) {
    throw new Error(
      "PSBT does not match verified blockchain UTXO"
    );
  }

  return {
    verified: true,
    confirmations: utxo.confirmations,
    address,
    amountSats: actualSats,
  };
}
