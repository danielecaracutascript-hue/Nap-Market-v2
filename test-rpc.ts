// Script di test per verificare la connessione al nodo Bitcoin Core
// Esegui con: npx tsx test-rpc.ts

const URL = process.env.BITCOIN_RPC_URL ?? "http://127.0.0.1:18443";
const COOKIE_PATH = process.env.BITCOIN_RPC_COOKIE_PATH ?? "C:\\btc-poc\\regtest\\.cookie";

import { readFileSync } from "fs";

function authHeader() {
  const cookie = readFileSync(COOKIE_PATH, "utf8").trim();
  return "Basic " + Buffer.from(cookie).toString("base64");
}

async function rpc(method: string, params: unknown[] = [], wallet?: string) {
  const url = wallet ? `${URL}/wallet/${wallet}` : URL;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader() },
    body: JSON.stringify({ jsonrpc: "1.0", id: "test", method, params }),
  });
  const text = await res.text();
  const json = JSON.parse(text);
  if (json.error) throw new Error(method + ": " + json.error.message);
  return json.result;
}

(async () => {
  try {
    console.log("Test connessione Bitcoin Core...");
    console.log("URL:", URL);
    console.log("Cookie path:", COOKIE_PATH);

    const blockCount = await rpc("getblockcount");
    console.log("✓ Blocco corrente:", blockCount);

    const wallets = await rpc("listwallets");
    console.log("✓ Wallet caricati:", wallets.join(", "));

    const balance = await rpc("getbalance", [], "miner");
    console.log("✓ Balance miner:", balance, "BTC");

    console.log("\n✓ Connessione riuscita!");
  } catch (e) {
    console.error("✗ Errore:", (e as Error).message);
    process.exit(1);
  }
})();
