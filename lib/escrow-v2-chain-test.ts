// Compatibility entry point for the local chain check. Keeping a re-export,
// rather than a copy, guarantees that test validation and server validation
// use the same UTXO and P2WSH checks.
export { verifyEscrowV2Utxo } from "./escrow-v2-chain";
export type { VerifyEscrowV2UtxoArgs } from "./escrow-v2-chain";
