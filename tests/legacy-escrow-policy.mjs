import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const req=createRequire(path.join(root,'package.json'));
const ts=req('typescript');
const descriptors=req('@bitcoinerlab/descriptors');
const bitcoin=req('bitcoinjs-lib');
function load(file,requireFn=req,env={NEXT_PUBLIC_BITCOIN_NETWORK:'regtest'},transform=s=>s){
 const source=transform(fs.readFileSync(path.join(root,file.replace(/^marketplace\//,'')),'utf8'));
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const context={exports:{},require:requireFn,Buffer,process:{env}};
 vm.runInNewContext(code,context);
 return context.exports;
}
const {legacyEscrowKeys}=load('marketplace/lib/escrow-legacy-policy.ts');
const preparation=load('marketplace/lib/escrow-preparation.ts');
const settlements=load('marketplace/lib/escrow-settlement.ts',name=>name==='server-only'?{}:req(name));
const escrow=load('marketplace/lib/escrow.ts');
// Public curve generator and synthetic chain codes only. No private keys/seeds.
const publicPoint=Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798','hex');
const publicKey=(n)=>`[${String(n).repeat(8)}/84h/1h/0h]${descriptors.BIP32.fromPublicKey(publicPoint,Buffer.alloc(32,n),bitcoin.networks.testnet).toBase58()}`;
const old={buyerXpub:publicKey(1),sellerXpub:publicKey(2),platformXpub:publicKey(3)};
const rotated=publicKey(4);
const policy=(keys=old,t1=5,t2=10)=>{
 const k=(x,b)=>`${x}/${b}/*`;
 return `wsh(or_i(and_v(v:pk(${k(keys.platformXpub,0)}),or_d(pk(${k(keys.buyerXpub,0)}),pk(${k(keys.sellerXpub,0)}))),or_i(and_v(v:multi(2,${k(keys.buyerXpub,2)},${k(keys.sellerXpub,2)}),older(${t1})),and_v(v:pk(${k(keys.buyerXpub,1)}),older(${t2})))))`;
};
const original=policy();
const normalized=(x)=>x.replace(/(\d)h/g,"$1'");
async function route(purpose,action,descriptor=original,existing=null,options={}){
 const builds=[],checks=[],writes=[];
 const order={id:'synthetic-order',buyer_id:'buyer',seller_id:'seller',status:purpose==='release'?'COMPLETED':'REFUNDED',escrow_protocol:'legacy_v1',price_sats:100000,buyer_commission_sats:4000,seller_commission_sats:4000,escrow_index:42,escrow_descriptor:descriptor,funding_txid:'a'.repeat(64),funding_vout:2,released_txid:null,refunded_txid:null,...options.order};
 const draft={id:'draft',psbt:'synthetic-psbt'};
 function query(table){
  const q={select(){return this},eq(){return this},in(column,values){if(column==='status')this.statuses=values;return this},order(){return this},limit(){return this},insert(row){writes.push(row);return this},async maybeSingle(){return {data:table==='orders'?order:(this.statuses?.includes('broadcast')?null:(action==='submit'?draft:existing))}},async single(){return {data:{id:'draft'},error:null}},then(resolve){resolve({data:options.events??[{type:'no_shipment_refund'}]})}};
  return q;
 }
 const stubEscrow={...escrow,
  buildReleasePsbt:async(args)=>{builds.push(args);return 'synthetic-psbt'},
  buildRefundPsbt:async(args)=>{builds.push(args);return 'synthetic-psbt'},
  verifyReleasePsbt:async(args)=>{checks.push(args);return {ok:false,reason:'offline stop before signing'}},
  verifyRefundPsbt:async(args)=>{checks.push(args);return {ok:false,reason:'offline stop before signing'}},
  txFingerprint:async()=> 'same-unsigned-transaction',
  signWith:async()=>{throw Error('Signing forbidden in this test')},
 };
 const env=new Proxy({RELEASE_FEE_SATS:options.fee??'700'}, {get(target,name){if(name in target)return target[name];throw Error('Environment access forbidden: '+String(name))}});
 const mod=load(`marketplace/app/api/orders/[id]/${purpose}/${action}/route.ts`,(name)=>{
  if(name==='next/server')return {NextResponse:{json:(body,options={})=>({body,status:options.status??200})}};
  if(name==='@/lib/escrow-legacy-policy')return {legacyEscrowKeys};
  if(name==='@/lib/escrow-settlement')return settlements;
  if(name==='@/lib/escrow-preparation')return preparation;
  if(name==='@/lib/escrow-submission')return {recordedSubmission:async()=>null,SubmissionCoordinationError:class extends Error{}};
  if(name==='@/lib/escrow')return stubEscrow;
  if(name==='@/lib/escrow-protocol')return {isLegacyEscrowProtocol:value=>value==='legacy_v1'};
  if(name==='@/lib/supabase/server')return {createClient:async()=>({auth:{getUser:async()=>({data:{user:{id:purpose==='release'?'seller':'buyer'}}})},from(table){assert.equal(table,'orders','Current profiles must not be read');return query(table)}})};
  if(name==='@/lib/supabase/admin')return {createAdminClient:()=>({from:query,rpc(){throw Error('DB RPC forbidden')}})};
  if(name==='@/lib/bitcoin')return {rpc:async(method)=>{assert.equal(method,'gettransaction','Mutating Bitcoin RPC forbidden');return {hex:'synthetic-transaction'}}};
  throw Error('Unexpected import '+name);
 },env);
 const response=await mod.POST({json:async()=>({psbt:'synthetic-psbt'})},{params:Promise.resolve({id:order.id})});
 return {...response,builds,checks,writes};
}
(async()=>{
 for(const d of [original,original+'#abcdefgh',original.replace(/(\d)h/g,"$1'"),policy(old,144,288)]){
  const parsed=legacyEscrowKeys(d);
  for(const role of Object.keys(old))assert.equal(parsed[role],normalized(old[role]));
 }
 const malformed=[null,'',original+'junk',original.replace('wsh(','sh('),original.replace('/2/*','/0/*'),original.replace('multi(2,','multi(1,'),original.replace('or_d(','or_i('),original.replace('older(5)','after(5)'),original.replace(`${old.buyerXpub}/1/*`,`${rotated}/1/*`),original.replace(`${old.sellerXpub}/2/*`,`${rotated}/2/*`),original.replace('tpub','tprv')];
 for(const d of malformed)assert.throws(()=>legacyEscrowKeys(d),/descriptor/);
 const parsed=legacyEscrowKeys(original);
 for(const role of Object.keys(old)){
  assert.equal(await escrow.payoutAddress(parsed[role],3,42),await escrow.payoutAddress(old[role],3,42));
  assert.notEqual(await escrow.payoutAddress(parsed[role],3,42),await escrow.payoutAddress(rotated,3,42));
 }
 for(const purpose of ['release','refund']){
  let r=await route(purpose,'prepare');assert.equal(r.status,200);assert.equal(r.builds.length,1);assert.equal(r.writes.length,1);
  const role=purpose==='release'?'sellerXpub':'buyerXpub';
  assert.equal(r.builds[0][role],parsed[role]);assert.equal(r.builds[0].platformXpub,parsed.platformXpub);
  r=await route(purpose,'submit');assert.equal(r.status,400);assert.equal(r.checks.length,1);assert.equal(r.writes.length,0);
  assert.equal(r.checks[0].platformAddress,await escrow.payoutAddress(old.platformXpub,3,42));
  assert.equal(r.checks[0][purpose==='release'?'sellerAddress':'buyerAddress'],await escrow.payoutAddress(old[role],3,42));
  r=await route(purpose,'prepare',original,{id:'existing-draft',psbt:'existing-psbt'});assert.equal(r.body.psbt,'existing-psbt');assert.equal(r.builds.length,0);assert.equal(r.writes.length,0);
  for(const action of ['prepare','submit']){r=await route(purpose,action,'unsupported-policy');assert.equal(r.status,500);assert.match(r.body.error,/manual review/);assert.equal(r.builds.length,0);assert.equal(r.checks.length,0);assert.equal(r.writes.length,0)}
  for(const action of ['prepare','submit']){r=await route(purpose,action,original,null,{order:{escrow_protocol:'escrow_v2'}});assert.equal(r.status,409);assert.equal(r.builds.length,0);assert.equal(r.checks.length,0);assert.equal(r.writes.length,0)}
 }
 let preparationCases=0;
 for(const purpose of ['release','refund']){
  for(const options of [
   ...['-1','5001','1.5','NaN',''].map(fee=>({fee})),
   ...[{price_sats:null},{buyer_commission_sats:null},{seller_commission_sats:-1},
    {price_sats:Number.MAX_SAFE_INTEGER},{escrow_index:null},{escrow_index:2147483648},
    {funding_vout:-1},{funding_txid:'bad'}].map(order=>({order})),
  ]){
   const r=await route(purpose,'prepare',original,null,options);
   assert.ok([409,503].includes(r.status));assert.equal(r.builds.length,0);assert.equal(r.writes.length,0);preparationCases++;
  }
  for(const fee of ['0','5000']){
   const r=await route(purpose,'prepare',original,null,{fee});assert.equal(r.status,200);assert.equal(r.builds.length,1);preparationCases++;
  }
  const existing=await route(purpose,'prepare',original,{id:'saved',psbt:'preserved'},{fee:'5001'});
  assert.equal(existing.status,200);assert.equal(existing.body.psbt,'preserved');assert.equal(existing.builds.length,0);preparationCases++;
 }
 const returned={type:'return_requested'},decided={type:'dispute_decided',data:{decision:'buyer'}};
 let refundPolicyCases=0;
 for(const [events,kind,platform] of [
  [[returned],'return',4000],[[decided],'dispute',0],
  [[returned,decided],'return',4000],[[decided,returned],'return',4000],
  [[{type:'no_shipment_refund'}],'no_shipment',0],
 ]){
  assert.equal(escrow.refundKindFromEvents(events),kind);
  assert.equal(escrow.refundAmounts({price_sats:100000,buyer_commission_sats:4000,seller_commission_sats:4000},kind).platform,platform);
  const prepared=await route('refund','prepare',original,null,{events});
  assert.equal(prepared.status,200);assert.equal(prepared.builds[0].platformAmount,platform);
  assert.equal(prepared.builds[0].buyerAmount,104000-platform-700);
  const submitted=await route('refund','submit',original,null,{events});
  assert.equal(submitted.status,400); // deliberate stop at public PSBT validation
  assert.equal(submitted.checks[0].platformAmount,platform);
  assert.equal(submitted.writes.length,0);refundPolicyCases++;
 }
 assert.equal(escrow.refundKindFromEvents([]),null);
 assert.equal(escrow.refundKindFromEvents([{type:'dispute_decided',data:{decision:'seller'}}]),null);
 console.log(`PASS: legacy parser/payout/route regressions, ${preparationCases} draft validation cases and ${refundPolicyCases} refund-policy cases across prepare/submit. Existing drafts preserved. No secrets, signing or live services.`);
})().catch(error=>{console.error(error);process.exitCode=1});
