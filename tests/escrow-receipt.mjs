import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const req=createRequire(path.join(root,'package.json'));
const ts=req('typescript');
function load(file,resolve,globals={},transform=s=>s){
 const source=transform(fs.readFileSync(path.join(root,file),'utf8'));
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const context={...globals,exports:{},require:resolve,process:{env:{NEXT_PUBLIC_TEST_MODE:'false'}}};
 vm.runInNewContext(compiled,context);
 return context.exports;
}
const tools=load('lib/escrow-receipt.ts',()=>{throw Error('Unexpected import')});
const receipt={broadcast:true,txid:'a'.repeat(64),reconciliationRequired:true};
for(const bad of [null,{},'invalid',{...receipt,txid:'invalid'},{...receipt,broadcast:false},{...receipt,reconciliationRequired:'true'}])assert.equal(tools.readBroadcastReceipt(bad),null);
const saved=tools.readBroadcastReceipt({...receipt,psbt:'must-not-be-stored',secret:'must-not-be-stored'});
assert.deepEqual(Object.keys(saved).sort(),['broadcast','reconciliationRequired','txid']);
assert.equal(tools.readBroadcastReceipt(JSON.parse(JSON.stringify(saved))).txid,receipt.txid);
assert.notEqual(tools.receiptStorageKey('user-a','order'),tools.receiptStorageKey('user-b','order'));
assert.notEqual(tools.receiptStorageKey('user','order-a'),tools.receiptStorageKey('user','order-b'));
async function browser(purpose,stage,storageFailure=false,pending=false,uncertain=false){
 const responseReceipt=uncertain?{...receipt,broadcast:false,submissionPending:true}:receipt;
 const role=purpose==='release'?'seller':'buyer';
 const order={escrow_index:42,escrow_descriptor:'synthetic-policy',funding_txid:'b'.repeat(64),funding_vout:2};
 const states=[role,order,[],[],true];states[18]=pending;
 const effects=[],messages=[],fetches=[],store=new Map();let index=0,unlocks=0,signs=0;
 const query={select(){return this},eq(){return this},order(){return this},limit(){return this},async maybeSingle(){return {data:order}},then(resolve){resolve({data:[]})}};
 const storage={getItem:key=>store.get(key),setItem(key,value){if(storageFailure)throw Error('Storage disabled');store.set(key,value)}};
 const mod=load('app/protected/orders/[id]/order-client.tsx',name=>{
  if(name==='react')return {useRef:initial=>({current:initial}),useEffect:effect=>effects.push(effect),useState(initial){const i=index++;return [i in states?states[i]:initial,value=>{if(i===5)messages.push(value)}]}};
  if(name==='react/jsx-runtime')return {};
  if(name==='next/link')return ()=>null;
  if(name==='@/lib/escrow-receipt')return tools;
  if(name==='@/lib/escrow-legacy-policy')return {legacyEscrowKeys:()=>({buyerXpub:'buyer',sellerXpub:'seller',platformXpub:'platform'})};
  if(name==='@/lib/escrow')return {
   releaseAmounts:()=>({escrowTotal:104000,platform:8000}),refundAmounts:()=>({escrowTotal:104000,platform:0}),refundKindFromEvents:()=> 'no_shipment',
   derivePubkey:async()=>new Uint8Array([1]),hexOf:()=> 'same-public-key',payoutAddress:async()=> 'synthetic-address',verifyReleasePsbt:async()=>({ok:true}),verifyRefundPsbt:async()=>({ok:true}),
   signWith:async()=>{signs++;return 'inert-signing-stub'},
  };
  if(name==='@/lib/wallet')return {loadRecord:()=>({xpub:'synthetic-public-key'}),unlock:async()=>{unlocks++;return 'inert-unlock-stub'}};
  if(name==='@/lib/supabase/client')return {createClient:()=>({auth:{getUser:async()=>({data:{user:{id:role}}})},from:()=>query})};
  throw Error('Unexpected import '+name);
 },{sessionStorage:storage,fetch:async url=>{fetches.push(url);return {ok:true,json:async()=>stage==='prepare'||url.endsWith('/submit')?responseReceipt:{psbt:'inert-psbt'}}}},
 // Expose existing handlers without rendering JSX or changing their bodies.
 s=>s.replace('  if (!loaded) return','  return { releaseFunds, claimRefund };\n  if (!loaded) return'));
 const handlers=mod.default({orderId:'synthetic-order'});
 await handlers[purpose==='release'?'releaseFunds':'claimRefund']({preventDefault(){}});
 if(pending){assert.equal(fetches.length,0);assert.equal(unlocks,0);return}
 assert.match(messages.at(-1),uncertain?/outcome is uncertain/:/The transaction was sent/);assert.doesNotMatch(messages.at(-1),/^Error:/);
 if(uncertain)assert.doesNotMatch(messages.at(-1),/The transaction was sent/);
 assert.match(messages.at(-1),/Do not submit another transaction/);assert.match(messages.at(-1),new RegExp(receipt.txid));
 assert.equal(fetches.length,stage==='prepare'?1:2);assert.equal(signs,stage==='prepare'?0:1);assert.equal(unlocks,stage==='prepare'?0:1);
 if(!storageFailure){
  const key=tools.receiptStorageKey(role,'synthetic-order');assert.equal(JSON.parse(store.get(key)).txid,receipt.txid);
  messages.length=0;effects.at(-1)();assert.match(messages.at(-1),uncertain?/outcome is uncertain/:/The transaction was sent/);
  assert.deepEqual(Object.keys(JSON.parse(store.get(key))).sort(),uncertain?['broadcast','reconciliationRequired','submissionPending','txid']:['broadcast','reconciliationRequired','txid']);
 }
}
for(const purpose of ['release','refund']){
 for(const stage of ['prepare','submit'])for(const storageFailure of [false,true])await browser(purpose,stage,storageFailure);
 await browser(purpose,'prepare',false,true);
 for(const stage of ['prepare','submit'])await browser(purpose,stage,false,false,true);
}
async function statusCheck(responseBody,ok=true) {
 const currentOrder={id:'synthetic-order',buyer_id:'buyer',seller_id:'seller',status:'COMPLETED'};
 const states=['buyer',currentOrder,[],[],true];states[18]=true;
 let i=0,requests=0;const messages=[],checking=[],stored=new Map();
 const query={select(){return this},eq(){return this},order(){return this},limit(){return this},async maybeSingle(){return {data:currentOrder}},then(resolve){resolve({data:[]})}};
 const mod=load('app/protected/orders/[id]/order-client.tsx',name=>{
  if(name==='react')return {useRef:initial=>({current:initial}),useEffect(){},useState(initial){const index=i++;return [index in states?states[index]:initial,value=>{if(index===5)messages.push(value);if(index===20)checking.push(value)}]}};
  if(name==='react/jsx-runtime')return {};if(name==='next/link')return ()=>null;
  if(name==='@/lib/escrow-receipt')return tools;
  if(name==='@/lib/escrow'||name==='@/lib/escrow-legacy-policy')return {};
  if(name==='@/lib/wallet')return {loadRecord(){throw Error('Wallet access forbidden')},unlock(){throw Error('Unlock forbidden')}};
  if(name==='@/lib/supabase/client')return {createClient:()=>({auth:{getUser:async()=>({data:{user:{id:'buyer'}}})},from:()=>query})};
  throw Error('Unexpected import '+name);
 },{sessionStorage:{getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value)},fetch:async(url,options)=>{requests++;assert.ok(url.endsWith('/settlement/reconcile'));assert.equal(options.method,'POST');return {ok,json:async()=>responseBody}}},s=>s.replace('  if (!loaded) return','  return { checkSettlementStatus };\n  if (!loaded) return'));
 await mod.default({orderId:'synthetic-order'}).checkSettlementStatus();
 assert.equal(requests,1);assert.deepEqual(checking,[true,false]);
 if(ok){assert.ok(stored.has(tools.receiptStorageKey('buyer','synthetic-order')));assert.match(messages.at(-1),new RegExp(receipt.txid))}
 else {assert.equal(stored.size,0);assert.match(messages.at(-1),/Status unavailable/)}
}
await statusCheck({...receipt,reconciliationRequired:false,message:'The transaction was sent and recorded.'});
await statusCheck({...receipt,message:'The transaction was sent. Synchronization needs review.'});
await statusCheck({...receipt,broadcast:false,submissionPending:true,message:'Independent proof unavailable; reservation remains blocked.'});
await statusCheck({error:'Status unavailable'},false);
console.log('PASS: receipt validation/storage isolation and 18 browser handler scenarios, including reload, disabled storage and duplicate submission. Wallet/signing are inert stubs.');
