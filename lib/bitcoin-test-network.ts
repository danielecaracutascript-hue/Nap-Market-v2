/** Public configuration mapping; no node, wallet or credential access. */
export function testChainForNetwork(network: string): string | null {
  switch (network) {
    case "regtest": return "regtest";
    case "testnet": return "test";
    case "signet": return "signet";
    default: return null;
  }
}
