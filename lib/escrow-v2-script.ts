import * as bitcoin from "bitcoinjs-lib";
import * as descriptors from "@bitcoinerlab/descriptors";
import type { EscrowParticipants } from "./escrow-v2";

function parseAccountXpub(value: string): string {
  const match = value.trim().match(
    /^\[[0-9a-fA-F]{8}\/84h\/1h\/0h\](tpub[1-9A-HJ-NP-Za-km-z]{100,120})$/
  );

  if (!match) {
    throw new Error("Invalid escrow participant account xpub");
  }

  return match[1];
}

export function deriveEscrowV2WitnessScript(
  participants: EscrowParticipants,
  index: number
): Uint8Array {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= 0x80000000
  ) {
    throw new Error("Invalid escrow derivation index");
  }

  const network = bitcoin.networks.testnet;

  const accountKeys = [
    participants.buyerXpub,
    participants.sellerXpub,
    participants.platformEscrowXpub,
  ];

  const pubkeys = accountKeys.map((value) => {
    const xpub = parseAccountXpub(value);

    const account = descriptors.BIP32.fromBase58(
      xpub,
      network
    );

    const child = account.derive(0).derive(index);

    return Buffer.from(child.publicKey);
  });

  const unique = new Set(
    pubkeys.map((key) => key.toString("hex"))
  );

  if (unique.size !== 3) {
    throw new Error("Escrow requires three distinct public keys");
  }

  pubkeys.sort(Buffer.compare);

  return bitcoin.script.compile([
    bitcoin.opcodes.OP_2,
    ...pubkeys,
    bitcoin.opcodes.OP_3,
    bitcoin.opcodes.OP_CHECKMULTISIG,
  ]);
}
