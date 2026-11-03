export type EscrowProtocol = "legacy_v1" | "escrow_v2";

/**
 * Legacy routes must fail closed for every other protocol. The database column
 * is NOT NULL and defaults to legacy_v1, so an undefined value can only occur
 * in a broken or outdated caller and is deliberately rejected as well.
 */
export function isLegacyEscrowProtocol(value: unknown): value is "legacy_v1" {
  return value === "legacy_v1";
}
