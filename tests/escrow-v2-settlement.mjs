import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireNode = createRequire(path.join(root, "package.json"));
const ts = requireNode("typescript");
const bitcoin = requireNode("bitcoinjs-lib");
const descriptors = requireNode("@bitcoinerlab/descriptors");

function load(relative) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const context = {
    exports: {}, Buffer,
    require(name) {
      if (name === "server-only") return {};
      if (name === "bitcoinjs-lib" || name === "@bitcoinerlab/descriptors") return requireNode(name);
      if (name.startsWith("./")) return load(path.join(path.dirname(relative), `${name.slice(2)}.ts`));
      throw new Error(`Unexpected import ${name}`);
    },
  };
  vm.runInNewContext(code, context);
  return context.exports;
}

const { deriveEscrowV2WitnessScript } = load("lib/escrow-v2-script.ts");
const { verifyEscrowV2Settlement } = load("lib/escrow-v2-settlement.ts");
const { buildEscrowV2Settlement } = load("lib/escrow-v2-settlement-builder.ts");
const point = Buffer.from("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "hex");
const xpub = (n) => `[${String(n).repeat(8)}/84h/1h/0h]${descriptors.BIP32.fromPublicKey(point, Buffer.alloc(32, n), bitcoin.networks.testnet).toBase58()}`;
const participants = { buyerXpub: xpub(1), sellerXpub: xpub(2), platformEscrowXpub: xpub(3) };
const index = 42;
const witnessScript = deriveEscrowV2WitnessScript(participants, index);
const lockingScript = bitcoin.script.compile([bitcoin.opcodes.OP_0, bitcoin.crypto.sha256(witnessScript)]);
const seller = bitcoin.address.fromOutputScript(bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 4), network: bitcoin.networks.regtest }).output, bitcoin.networks.regtest);
const platform = bitcoin.address.fromOutputScript(bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 5), network: bitcoin.networks.regtest }).output, bitcoin.networks.regtest);
const txid = "a".repeat(64);

function psbt(outputs = [[seller, 92000n], [platform, 8000n]]) {
  const value = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  value.addInput({ hash: txid, index: 2, witnessUtxo: { script: lockingScript, value: 104000n }, witnessScript: Buffer.from(witnessScript) });
  for (const [address, sats] of outputs) value.addOutput({ address, value: sats });
  return value.toBase64();
}

const args = (psbtBase64, expectedOutputs = [{ address: seller, valueSats: 92000n }, { address: platform, valueSats: 8000n }]) => ({
  psbtBase64, participants, escrowIndex: index, expectedTxid: txid, expectedVout: 2,
  expectedWitnessScript: witnessScript, expectedInputSats: 104000n, expectedOutputs,
  maxFeeSats: 5000n, network: "regtest",
});

assert.equal(verifyEscrowV2Settlement(args(psbt())).feeSats, 4000n);
assert.throws(() => verifyEscrowV2Settlement(args(psbt([[seller, 91999n], [platform, 8000n]]))), /Unexpected settlement output/);
assert.throws(() => verifyEscrowV2Settlement(args(psbt([[seller, 92000n], [platform, 8000n], [seller, 1n]]))), /Unexpected settlement output count/);
assert.throws(() => verifyEscrowV2Settlement(args(psbt(), [{ address: seller, valueSats: 92000n }, { address: seller, valueSats: 8000n }])), /Duplicate expected settlement destination/);
assert.throws(() => verifyEscrowV2Settlement(args(psbt([[seller, 92000n], [platform, 6000n]]), [{ address: seller, valueSats: 92000n }, { address: platform, valueSats: 6000n }])), /Settlement fee exceeds authorized limit/);
const funding = new bitcoin.Transaction();
funding.addInput(Buffer.alloc(32, 7), 0);
funding.addOutput(lockingScript, 104000n);
const built = buildEscrowV2Settlement({ participants, escrowIndex: index, fundingTxHex: funding.toHex(), fundingVout: 0,
  outputs: [{ address: seller, valueSats: 92000n }, { address: platform, valueSats: 8000n }], network: "regtest" });
assert.equal(built.inputSats, 104000n);
assert.equal(verifyEscrowV2Settlement({ psbtBase64: built.psbtBase64, participants, escrowIndex: index,
  expectedTxid: built.txid, expectedVout: 0, expectedWitnessScript: built.witnessScript,
  expectedInputSats: 104000n, expectedOutputs: [{ address: seller, valueSats: 92000n }, { address: platform, valueSats: 8000n }],
  maxFeeSats: 5000n, network: "regtest" }).feeSats, 4000n);
assert.throws(() => buildEscrowV2Settlement({ participants, escrowIndex: index, fundingTxHex: funding.toHex(), fundingVout: 1,
  outputs: [{ address: seller, valueSats: 92000n }], network: "regtest" }), /Funding output does not exist/);
console.log("PASS: 8 offline Escrow V2 settlement checks. Only synthetic public keys and unsigned PSBTs were used; no signing, finalization, RPC or broadcast.");
