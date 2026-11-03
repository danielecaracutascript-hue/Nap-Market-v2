import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(path.join(root, "package.json"))("typescript");
const source = fs.readFileSync(path.join(root, "app/api/orders/[id]/escrow-v2/route.ts"), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

async function run({ enabled = false, protocol = "legacy_v1" } = {}) {
  const calls = [];
  const context = { exports: {}, Buffer, process: { env: enabled ? { ESCROW_V2_ENABLED: "true" } : {} }, require(name) {
    if (name === "next/server") return { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) } };
    if (name === "@/lib/supabase/server") return { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "buyer" } } }) }, from() { calls.push("order-read"); return { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { id: "order", buyer_id: "buyer", seller_id: "seller", status: "CREATED", escrow_protocol: protocol, escrow_index: 1, escrow_address: null, expires_at: "2099-01-01" }, error: null }) }; } }) };
    if (name === "@/lib/supabase/admin") return { createAdminClient: () => { calls.push("admin"); throw new Error("Admin must not be reached"); } };
    if (name === "@/lib/bitcoin") return { rpc: async () => { calls.push("rpc"); throw new Error("RPC must not be reached"); } };
    if (name === "@/lib/bitcoin-test-network") return { testChainForNetwork: () => "regtest" };
    if (name === "@/lib/escrow-v2") return { candidateEscrowDescriptor: () => "unused" };
    if (name === "@/lib/escrow-v2-script") return { deriveEscrowV2WitnessScript: () => new Uint8Array() };
    throw new Error(`Unexpected import ${name}`);
  } };
  vm.runInNewContext(code, context);
  return { ...(await context.exports.POST({}, { params: Promise.resolve({ id: "order" }) })), calls };
}

const disabled = await run();
assert.equal(disabled.status, 503);
assert.deepEqual(disabled.calls, []);
const legacy = await run({ enabled: true });
assert.equal(legacy.status, 409);
assert.deepEqual(legacy.calls, ["order-read"]);
console.log("PASS: Escrow V2 creation route stays disabled by default and rejects Legacy before profile, RPC or write access.");
