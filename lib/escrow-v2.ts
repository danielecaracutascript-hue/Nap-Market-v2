/**
 * Candidate non-custodial 2-of-3 policy for test-network integration.
 *
 * IMPORTANT: This module does not activate the new escrow flow. Existing
 * funded orders must continue using their original immutable descriptor.
 * Validate with Bitcoin Core and independent signers before integrating.
 */
export type EscrowParticipants = Readonly<{
  buyerXpub: string;
  sellerXpub: string;
  platformEscrowXpub: string;
}>;

function publicExtendedKey(value: string, role: string): string {
  if (typeof value !== "string") {
    throw new Error(`Missing public extended key for ${role}`);
  }

  const key = value.trim();

  // Formato prodotto da lib/wallet.ts:
  // [fingerprint/84h/1h/0h]tpub...
  const match = key.match(
    /^\[([0-9a-fA-F]{8})\/84h\/1h\/0h\](tpub[1-9A-HJ-NP-Za-km-z]{100,120})$/
  );

  if (!match) {
    throw new Error(`Invalid account public key for ${role}`);
  }

  return `[${match[1].toLowerCase()}/84h/1h/0h]${match[2]}`;
}
/**
 * Native SegWit P2WSH sorted 2-of-3 multisig.
 * Every participant must independently derive and verify the resulting
 * address, script, index and fee policy before sending test funds.
 *
 * Uses branch /0/index for each participant; the index is fixed by the
 * order and MUST be immutable before an address is presented.
 */
export function candidateEscrowDescriptor(
  participants: EscrowParticipants,
  index: number,
): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error("Invalid non-hardened escrow index");
  }
  const buyer = publicExtendedKey(participants.buyerXpub, "buyer");
  const seller = publicExtendedKey(participants.sellerXpub, "seller");
  const platformEscrow = publicExtendedKey(
    participants.platformEscrowXpub,
    "platform escrow"
  );

  if (new Set([buyer, seller, platformEscrow].map((key) => key.slice(key.indexOf("]") + 1))).size !== 3) {
    throw new Error("Escrow requires three distinct public extended keys");
  }
  // Fixed-index descriptor, no wildcard, so the exact script can be
  // persisted and audited per order. Core adds checksum via getdescriptorinfo.
  return `wsh(sortedmulti(2,${buyer}/0/${index},${seller}/0/${index},${platformEscrow}/0/${index}))`;
}

