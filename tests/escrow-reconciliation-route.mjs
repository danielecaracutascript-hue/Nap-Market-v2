import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const req=createRequire(path.join(root,'package.json')),ts=req('typescript');
function load(file,resolve,globals={}){
 const code=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017}}).outputText;
 const context={...globals,exports:{},require:resolve};vm.runInNewContext(code,context);return context.exports;
}
const settlement=load('lib/escrow-settlement.ts',name=>{assert.equal(name,'server-only');return {}});
const refundPolicy=load('lib/escrow.ts',()=>{throw Error('No crypto or wallet imports allowed for event classification')},{process:{env:{NEXT_PUBLIC_BITCOIN_NETWORK:'regtest'}}});
const submission=load('lib/escrow-submission.ts',name=>{
 if(name==='server-only')return {};if(name==='./escrow-settlement')return settlement;
 if(name==='node:crypto'||name==='bitcoinjs-lib')return req(name);throw Error('Unexpected import');
});
const txid='a'.repeat(64);
async function run(options={}){
 const reads=[],writes=[],proofs=[];let admins=0;
 const order={id:'order',buyer_id:'buyer',seller_id:'seller',status:options.refund?'REFUNDED':'COMPLETED',escrow_protocol:options.protocol??'legacy_v1',price_sats:100000,buyer_commission_sats:4000,seller_commission_sats:4000,escrow_index:42,escrow_descriptor:'original-public-policy',escrow_address:'synthetic-address',funding_txid:'b'.repeat(64),funding_vout:2,released_txid:null,refunded_txid:null};
 const claim={order_id:'order',purpose:options.refund?'refund':'release',txid,funding_txid:order.funding_txid,funding_vout:2,psbt_id:'draft',claim_id:'claim',state:'pending'};
 const draft={id:'draft',order_id:'order',purpose:options.draftMismatch?'other':claim.purpose,psbt:'synthetic-psbt'};
 function query(table){
  reads.push(table);
  return {select(){return this},eq(){return this},async maybeSingle(){
   return {data:table==='orders'?(options.noOrder?null:order):table==='escrow_submission_claims'?(options.noClaim?null:claim):(options.noDraft?null:draft),error:options.errorTable===table?{message:'simulated read error'}:null};
  },then(resolve){resolve({data:options.events??[{type:'no_shipment_refund'}],error:options.eventError?{message:'simulated event error'}:null})}};
 }
 const mod=load('app/api/orders/[id]/settlement/reconcile/route.ts',name=>{
  if(name==='next/server')return {NextResponse:{json:(body,opts={})=>({body,status:opts.status??200})}};
  if(name==='@/lib/supabase/server')return {createClient:async()=>({auth:{getUser:async()=>({data:{user:options.guest?null:{id:options.user??'buyer'}}})},from:query})};
  if(name==='@/lib/supabase/admin')return {createAdminClient:()=>{admins++;return {from:query,async rpc(name,args){
   assert.equal(name,'reconcile_escrow_submission','Only atomic reconciliation writes are allowed');writes.push(args);
   if(options.rpcThrow)throw Error('simulated SQL failure');
   return {error:options.rpcError?{message:'simulated SQL failure'}:null,data:options.rpcData??{ok:true,txid,reconciled:true,confirmed:true}};
  }}}};
  if(name==='@/lib/escrow-reconciliation')return {verifyReservedSettlement:async args=>{
   proofs.push(args);if(options.proofThrow)throw Error('simulated verification failure');return options.unverified?{verified:false,reason:'Independent proof unavailable; reservation remains blocked.'}:{verified:true,txid,blockhash:'c'.repeat(64),confirmations:2};
  }};
  if(name==='@/lib/escrow')return {refundKindFromEvents:refundPolicy.refundKindFromEvents};
  if(name==='@/lib/escrow-protocol')return {isLegacyEscrowProtocol:value=>value==='legacy_v1'};
  if(name==='@/lib/escrow-settlement')return settlement;
  if(name==='@/lib/escrow-submission')return submission;
  throw Error('Forbidden import '+name);
 },{process:{env:new Proxy({},{get(target,name){assert.equal(name,'NEXT_PUBLIC_BITCOIN_NETWORK');return 'regtest'}})}});
 const result=await mod.POST({}, {params:Promise.resolve({id:'order'})});return {...result,reads,writes,proofs,admins,order,draft};
}
let count=0;
for(const options of [{},{user:'seller'},{refund:true}]){
 const r=await run(options);count++;assert.equal(r.status,200);assert.equal(r.body.reconciliationRequired,false);assert.equal(r.writes.length,1);assert.equal(r.writes[0].p_txid,txid);
 assert.equal(r.writes[0].p_expected.escrow_descriptor,r.order.escrow_descriptor);assert.equal(r.writes[0].p_expected.psbt,r.draft.psbt);assert.equal(r.writes[0].p_expected.price_sats,'100000');
}
for(const options of [{guest:true},{user:'stranger'}]){const r=await run(options);count++;assert.equal(r.status,options.guest?401:404);assert.equal(r.admins,0);assert.equal(r.proofs.length,0);assert.equal(r.writes.length,0)}
const v2=await run({protocol:'escrow_v2'});count++;assert.equal(v2.status,409);assert.equal(v2.admins,0);assert.equal(v2.proofs.length,0);assert.equal(v2.writes.length,0);
for(const options of [{noOrder:true},{errorTable:'orders'},{noClaim:true},{errorTable:'escrow_submission_claims'},{noDraft:true},{errorTable:'psbts'},{draftMismatch:true},{refund:true,eventError:true},{proofThrow:true}]){const r=await run(options);count++;assert.ok([404,503].includes(r.status));assert.equal(r.writes.length,0)}
const uncertain=await run({unverified:true});count++;assert.equal(uncertain.status,202);assert.equal(uncertain.body.broadcast,false);assert.equal(uncertain.body.submissionPending,true);assert.equal(uncertain.writes.length,0);
for(const options of [{rpcError:true},{rpcThrow:true},{rpcData:{ok:false}},{rpcData:{ok:true,txid:'d'.repeat(64),reconciled:true}},{rpcData:{ok:true,txid,reconciled:false}}]){
 const r=await run(options);count++;assert.equal(r.status,202);assert.equal(r.body.broadcast,true);assert.equal(r.body.txid,txid);assert.equal(r.body.reconciliationRequired,true);assert.equal(r.writes.length,1);
}
for(const events of [
 [{type:'return_requested'},{type:'dispute_decided',data:{decision:'buyer'}}],
 [{type:'dispute_decided',data:{decision:'buyer'}},{type:'return_requested'}],
]){
 const r=await run({refund:true,events});assert.equal(r.status,200);
 assert.equal(r.proofs[0].refundKind,'return');count++;
}
console.log(`PASS: ${count} reconciliation route scenarios, including access control, refund-policy consistency, no writes without independent proof and atomic-RPC failures. No live services.`);
