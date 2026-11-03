import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtime='C:\\progetti\\work\\integration-local';
const data=path.join(runtime,'regtest-readonly');
assert.equal(fs.readFileSync(path.join(data,'nap-isolated-regtest.marker'),'utf8').trim(),'nap-market-isolated-regtest-readonly');
const req=createRequire(path.join(root,'package.json')),ts=req('typescript');
const descriptors=req('@bitcoinerlab/descriptors'),bitcoin=req('bitcoinjs-lib');
function load(file){
 const code=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017}}).outputText;
 const context={exports:{},process:{env:{NEXT_PUBLIC_BITCOIN_NETWORK:'regtest'}},require(){throw Error('Unexpected module access')}};
 vm.runInNewContext(code,context);return context.exports;
}
const {legacyEscrowKeys}=load('lib/escrow-legacy-policy.ts');
const {libDescriptor}=load('lib/escrow.ts');
const methods=[];
function rpc(method,args=[]){
 assert.ok(['getblockchaininfo','getnetworkinfo','getdescriptorinfo','deriveaddresses','validateaddress'].includes(method));
 methods.push(method);
 const response=spawnSync(path.join(runtime,'bitcoin/runtime/bitcoin-32.1/bin/bitcoin-cli.exe'),[
  '-datadir='+data,'-regtest','-rpcport=19443','-rpcwait','-rpcwaittimeout=10',method,...args.map(value=>typeof value==='string'?value:JSON.stringify(value)),
 ],{encoding:'utf8',windowsHide:true,timeout:15000});
 if(response.status!==0)throw Error('Public Core RPC failed for '+method+': '+response.stderr.slice(0,300));
 return JSON.parse(response.stdout);
}
assert.equal(rpc('getblockchaininfo').chain,'regtest');
assert.equal(rpc('getnetworkinfo').networkactive,false);
// Public curve generator plus synthetic chain codes only. No private material.
const point=Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798','hex');
const key=n=>`[${String(n).repeat(8)}/84h/1h/0h]${descriptors.BIP32.fromPublicKey(point,Buffer.alloc(32,n),bitcoin.networks.testnet).toBase58()}`;
const original={buyerXpub:key(1),sellerXpub:key(2),platformXpub:key(3)};
const k=(x,b)=>`${x}/${b}/*`;
const descriptor=`wsh(or_i(and_v(v:pk(${k(original.platformXpub,0)}),or_d(pk(${k(original.buyerXpub,0)}),pk(${k(original.sellerXpub,0)}))),or_i(and_v(v:multi(2,${k(original.buyerXpub,2)},${k(original.sellerXpub,2)}),older(5)),and_v(v:pk(${k(original.buyerXpub,1)}),older(10)))))`;
const info=rpc('getdescriptorinfo',[descriptor]);
assert.equal(info.issolvable,true);assert.equal(info.hasprivatekeys,false);assert.equal(info.isrange,true);
assert.deepEqual(JSON.parse(JSON.stringify(legacyEscrowKeys(info.descriptor))),JSON.parse(JSON.stringify(legacyEscrowKeys(descriptor))));
let checks=3;const addresses=[];
for(const index of [0,42,10000]){
 const core=rpc('deriveaddresses',[info.descriptor,[index,index]]);
 const output=new descriptors.Output({descriptor:libDescriptor(info.descriptor),index,network:bitcoin.networks.regtest});
 assert.deepEqual(core,[output.getAddress()]);checks++;
 const validated=rpc('validateaddress',[core[0]]);
 assert.equal(validated.isvalid,true);
 assert.equal(validated.scriptPubKey,Buffer.from(output.getScriptPubKey()).toString('hex'));checks++;
 addresses.push({index,address:core[0]});
}
assert.equal(new Set(addresses.map(value=>value.address)).size,3);checks++;
const before=rpc('getblockchaininfo');assert.equal(before.blocks,0);
const network=rpc('getnetworkinfo');assert.equal(network.connections,0);checks++;
fs.writeFileSync(path.join(runtime,'core-descriptor-report.json'),JSON.stringify({checks,coreVersion:'32.1',chain:'regtest',addresses,methods,privateMaterial:false,transactions:0},null,2));
console.log(`PASS: ${checks} real Core public-descriptor checks. Canonical policy and addresses/scripts match the app at indices 0, 42 and 10000. No wallet, blocks, signing, finalization or broadcast.`);
