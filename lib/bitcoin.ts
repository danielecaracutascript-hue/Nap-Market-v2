import "server-only";

﻿import { readFileSync } from "fs";

const URL = process.env.BITCOIN_RPC_URL ?? "http://127.0.0.1:38332";

function authHeader() {
  const cookie = readFileSync(process.env.BITCOIN_RPC_COOKIE_PATH as string, "utf8").trim();
  return "Basic " + Buffer.from(cookie).toString("base64");
}

export async function rpc<T = unknown>(method: string, params: unknown[] = [], wallet?: string, signal?: AbortSignal): Promise<T> {
  const url = wallet ? `${URL}/wallet/${wallet}` : URL;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader() },
    body: JSON.stringify({ jsonrpc: "1.0", id: "app", method, params }),
    cache: "no-store",
    signal,
  });
  const text = await res.text();
  let json: { result?: T; error?: { message: string } | null };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Bitcoin node answered HTTP " + res.status);
  }
  if (json.error) throw new Error(method + ": " + json.error.message);
  return json.result as T;
}
