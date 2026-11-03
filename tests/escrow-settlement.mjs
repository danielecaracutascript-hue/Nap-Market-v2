import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const req=createRequire(path.join(root,'package.json'));
const ts=req('typescript');
function load(file,resolve,env={}){
 const source=fs.readFileSync(path.join(root,file),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017}}).outputText;
 const context={exports:{},require:resolve,process:{env}};
 vm.runInNewContext(compiled,context);
 return context.exports;
}
const helper=load('lib/escrow-settlement.ts',name=>{assert.equal(name,'server-only');return {}});
const preparation=load('lib/escrow-preparation.ts',()=>{throw Error('Unexpected import')});
const txid='a'.repeat(64);
const submission=load('lib/escrow-submission.ts',name=>{
 if(name==='server-only')return {};
 if(name==='node:crypto')return req(name);
 if(name==='bitcoinjs-lib')return {Transaction:{fromHex:()=>({getId:()=>txid})}};
 if(name==='./escrow-settlement')return helper;
 throw Error('Unexpected helper import '+name);
});
async function run(purpose,action,scenario={}){
 const calls=[];
 const column=purpose==='release'?'released_txid':'refunded_txid';
 const order={id:'test-order',buyer_id:'buyer',seller_id:'seller',status:purpose==='release'?'COMPLETED':'REFUNDED',escrow_protocol:'legacy_v1',escrow_index:42,escrow_descriptor:'synthetic-public-policy',escrow_address:'synthetic-address',funding_txid:'b'.repeat(64),funding_vout:2,price_sats:100000,buyer_commission_sats:4000,seller_commission_sats:4000,[column]:scenario.orderTxid??null};
 function query(table){
  return {updating:false,statuses:[],
   select(){return this},eq(){return this},in(column,values){if(column==='status')this.statuses=values;return this},order(){return this},limit(){return this},
   update(){calls.push(table==='escrow_submission_claims'?'claim-write':'psbt-write');this.updating=true;return this},
   async maybeSingle(){
    if(table==='orders')return {data:order,error:scenario.orderReadError?{message:'synthetic unavailable order'}:null};
    if(table==='escrow_submission_claims'){
      if(this.updating)return {data:scenario.claimWriteError?null:{order_id:order.id},error:scenario.claimWriteError?{message:'simulated claim write failure'}:null};
      return {data:scenario.pendingClaim??null,error:scenario.claimReadError?{message:'missing schema'}:null};
    }
    if(this.updating){if(scenario.psbtThrow)throw Error('simulated write exception');return {data:scenario.psbtMissing?null:{id:'draft'},error:scenario.psbtError?{message:'simulated write failure'}:null}};
    if(this.statuses.includes('broadcast')){calls.push('broadcast-read');return {data:scenario.previous===undefined?null:{txid:scenario.previous},error:scenario.readError?{message:'simulated lookup failure'}:null}};
    return {data:scenario.noDraft?null:{id:'draft',psbt:'synthetic-psbt'},error:scenario.draftError?{message:'simulated draft failure'}:null};
   },
   then(resolve){resolve({data:[{type:'no_shipment_refund'}],error:scenario.eventReadError?{message:'synthetic unavailable events'}:null})},
  };
 }
 const admin={from:query,async rpc(name,args){if(name==='claim_escrow_submission'){calls.push('claim');return scenario.claimError?{data:null,error:{message:'claim failed'}}:{data:{acquired:scenario.acquire!==false,order_id:order.id,purpose,txid,state:'pending',claim_id:args.p_claim_id},error:null}}assert.equal(name,'reconcile_escrow_submission');calls.push('atomic-record');assert.equal(args.p_confirmed,false);assert.equal(args.p_psbt,'synthetic-combined-psbt');assert.equal(args.p_expected.psbt,'synthetic-psbt');if(scenario.orderThrow||scenario.psbtThrow)throw Error('simulated atomic exception');return {data:scenario.psbtMissing?null:{ok:true,txid,reconciled:true},error:scenario.orderError||scenario.psbtError?{message:'simulated atomic failure'}:null}}};
 const escrow={
  derivePubkey:async(key)=>new Uint8Array([key==='platform'?2:1]),hexOf:key=>String(key[0]),payoutAddress:async(key)=>'synthetic-'+key,
  releaseAmounts:()=>({escrowTotal:104000,platform:8000}),refundAmounts:()=>({escrowTotal:104000,platform:0}),refundKindFromEvents:()=> 'no_shipment',
  verifyReleasePsbt:async()=>({ok:true}),verifyRefundPsbt:async()=>({ok:true}),txFingerprint:async()=> 'same-unsigned-tx',
  // These are inert stubs. No cryptography, wallets or transaction finalization.
  signWith:async()=>{calls.push('sign-stub');return 'synthetic-combined-psbt'},sigPubkeys:async()=>['1','2'],
 };
 const mod=load(`app/api/orders/[id]/${purpose}/${action}/route.ts`,name=>{
  if(name==='@/lib/escrow-settlement')return helper;
  if(name==='@/lib/escrow-preparation')return preparation;
  if(name==='@/lib/escrow-submission')return submission;
  if(name==='@/lib/escrow-legacy-policy')return {legacyEscrowKeys:()=>({buyerXpub:'buyer',sellerXpub:'seller',platformXpub:'platform'})};
  if(name==='next/server')return {NextResponse:{json:(body,options={})=>({body,status:options.status??200})}};
  if(name==='@/lib/supabase/server')return {createClient:async()=>({auth:{getUser:async()=>({data:{user:{id:purpose==='release'?'seller':'buyer'}}})},from:query})};
  if(name==='@/lib/supabase/admin')return {createAdminClient:()=>admin};
  if(name==='@/lib/escrow')return escrow;
  if(name==='@/lib/escrow-protocol')return {isLegacyEscrowProtocol:value=>value==='legacy_v1'};
  if(name==='@/lib/bitcoin')return {rpc:async(method)=>{calls.push(method);if(method==='descriptorprocesspsbt')return {complete:true,hex:'not-a-real-transaction'};if(method==='sendrawtransaction'){if(scenario.sendError)throw Error('simulated network failure');return scenario.wrongAck?'c'.repeat(64):txid}throw Error('Unexpected RPC '+method)}};
  throw Error('Unexpected import '+name);
 },new Proxy({}, {get(target,name){if(name==='PLATFORM_MNEMONIC'){calls.push('signing-config-stub');return 'unused-by-inert-stub'}throw Error('Unexpected config read '+String(name))}}));
 const response=await mod.POST({json:async()=>({psbt:'synthetic-psbt'})},{params:Promise.resolve({id:'test-order'})});
 return {...response,calls};
}
let scenarios=0;
for(const purpose of ['release','refund']){
 let r=await run(purpose,'submit');scenarios++;
 assert.equal(r.status,200);assert.equal(r.body.reconciliationRequired,false);assert.equal(r.body.txid,txid);assert.equal(r.calls.filter(x=>x==='sendrawtransaction').length,1);
 for(const failure of [{psbtError:true},{psbtThrow:true},{psbtMissing:true},{orderError:true},{orderThrow:true},{psbtError:true,orderError:true},{psbtThrow:true,orderThrow:true}]){
  r=await run(purpose,'submit',failure);scenarios++;
  assert.equal(r.status,202);assert.equal(r.body.broadcast,true);assert.equal(r.body.txid,txid);assert.equal(r.body.reconciliationRequired,true);assert.match(r.body.message,/Do not submit another transaction/);
  assert.ok(r.calls.includes('atomic-record'),'Atomic recording must be attempted');assert.ok(!r.calls.includes('order-write'));assert.ok(!r.calls.includes('psbt-write'));assert.equal(r.calls.filter(x=>x==='sendrawtransaction').length,1);
 }
 for(const action of ['prepare','submit']){
  for(const previous of [txid,null]){
   r=await run(purpose,action,{previous});scenarios++;
   assert.equal(r.status,previous?202:500);if(previous){assert.equal(r.body.txid,txid);assert.equal(r.body.alreadyBroadcast,true)}
   assert.ok(!r.calls.includes('sign-stub'));assert.ok(!r.calls.includes('sendrawtransaction'));assert.ok(!r.calls.includes('signing-config-stub'));
  }
  r=await run(purpose,action,{readError:true});scenarios++;assert.equal(r.status,500);assert.ok(!r.calls.includes('signing-config-stub'));assert.ok(!r.calls.includes('sendrawtransaction'));
  r=await run(purpose,action,{draftError:true});scenarios++;assert.equal(r.status,500);assert.ok(!r.calls.includes('signing-config-stub'));assert.ok(!r.calls.includes('sendrawtransaction'));
  r=await run(purpose,action,{orderTxid:txid});scenarios++;assert.equal(r.status,200);assert.equal(r.body.txid,txid);assert.equal(r.body.alreadyBroadcast,true);assert.equal(r.calls.length,0);
 }
 for(const state of ['pending','broadcast','reconciled'])for(const action of ['prepare','submit']){
  r=await run(purpose,action,{pendingClaim:{txid,state}});scenarios++;assert.equal(r.status,202);assert.equal(r.body.txid,txid);assert.equal(r.body.broadcast,state!=='pending');assert.ok(!r.calls.includes('sign-stub'));assert.ok(!r.calls.includes('sendrawtransaction'));
 }
 for(const action of ['prepare','submit']){r=await run(purpose,action,{claimReadError:true});scenarios++;assert.equal(r.status,503);assert.ok(!r.calls.includes('signing-config-stub'));assert.ok(!r.calls.includes('sendrawtransaction'))}
 for(const scenario of [{acquire:false},{claimError:true}]){r=await run(purpose,'submit',scenario);scenarios++;assert.equal(r.status,scenario.claimError?503:202);assert.ok(!r.calls.includes('sendrawtransaction'))}
 r=await run(purpose,'submit',{wrongAck:true});scenarios++;assert.equal(r.status,202);assert.equal(r.body.broadcast,false);assert.equal(r.body.txid,txid);assert.ok(!r.calls.includes('psbt-write'));
 r=await run(purpose,'submit',{claimWriteError:true});scenarios++;assert.equal(r.status,200);assert.equal(r.body.broadcast,true);assert.equal(r.body.reconciliationRequired,false);
 r=await run(purpose,'submit',{sendError:true});scenarios++;assert.equal(r.status,202);assert.equal(r.body.broadcast,false);assert.equal(r.body.submissionPending,true);assert.equal(r.body.txid,txid);assert.ok(!r.calls.includes('psbt-write'));assert.ok(!r.calls.includes('order-write'));
}
for(const purpose of ['release','refund'])for(const action of ['prepare','submit']){
 const r=await run(purpose,action,{orderReadError:true});scenarios++;
 assert.equal(r.status,503);assert.ok(!r.calls.includes('signing-config-stub'));
 assert.ok(!r.calls.includes('sign-stub'));assert.ok(!r.calls.includes('sendrawtransaction'));
 assert.ok(!r.calls.includes('claim'));assert.ok(!r.calls.includes('psbt-write'));
}
for(const action of ['prepare','submit']){
 const r=await run('refund',action,{eventReadError:true,noDraft:action==='prepare'});scenarios++;
 assert.equal(r.status,503);assert.ok(!r.calls.includes('signing-config-stub'));
 assert.ok(!r.calls.includes('sign-stub'));assert.ok(!r.calls.includes('sendrawtransaction'));
 assert.ok(!r.calls.includes('claim'));assert.ok(!r.calls.includes('psbt-write'));
}
console.log(`PASS: ${scenarios} offline settlement scenarios. Broadcast/signing/finalization are inert stubs; no configuration secrets or live services accessed.`);
