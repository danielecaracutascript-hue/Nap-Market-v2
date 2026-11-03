import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const req=createRequire(path.join(root,'package.json')),ts=req('typescript');
const bitcoin=req('bitcoinjs-lib'),{BIP32}=req('@bitcoinerlab/descriptors');
const point=Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798','hex');
const publicAccount=BIP32.fromPublicKey(point,Buffer.alloc(32,7),bitcoin.networks.testnet);
const publicKey=publicAccount.toBase58();
const code=ts.transpileModule(fs.readFileSync(path.join(root,'lib/escrow.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017}}).outputText;
function load(network){
 const context={exports:{},process:{env:{NEXT_PUBLIC_BITCOIN_NETWORK:network}},require(name){
  if(name==='bip39')return {mnemonicToSeedSync(){throw Error('Seed access forbidden')}};
  return req(name);
 }};
 vm.runInNewContext(code,context);return context.exports;
}
let count=0;
for(const [name,network] of [['testnet',bitcoin.networks.testnet],['signet',bitcoin.networks.testnet],['regtest',bitcoin.networks.regtest]]){
 const expected=bitcoin.payments.p2wpkh({pubkey:publicAccount.derive(3).derive(42).publicKey,network}).address;
 assert.equal(await load(name).payoutAddress(publicKey,3,42),expected);count++;
}
await assert.rejects(()=>load('invalid').payoutAddress(publicKey,3,42),/Unsupported Bitcoin network/);count++;
console.log(`PASS: ${count} public legacy network cases. No mnemonic, seed, private keys, signing or live services.`);
