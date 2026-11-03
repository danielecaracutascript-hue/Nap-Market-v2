import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ts=createRequire(path.join(root,'package.json'))('typescript');
const code=ts.transpileModule(fs.readFileSync(path.join(root,'app/api/orders/[id]/check-payment/route.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017}}).outputText;
const networkCode=ts.transpileModule(fs.readFileSync(path.join(root,'lib/bitcoin-test-network.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const networkContext={exports:{}};vm.runInNewContext(networkCode,networkContext);
async function run(options={}){
 const writes=[],reads=[];
 const order={id:'order',buyer_id:'buyer',seller_id:'seller',status:'CREATED',escrow_protocol:'legacy_v1',price_sats:100000,buyer_commission_sats:4000,shipping_sats:1000,escrow_descriptor:'saved-policy',escrow_index:42,escrow_address:'escrow',shipping_address:'shipping',expires_at:'2099-01-01T00:00:00+00:00',...options.order};
 const context={exports:{},process:{env:{NEXT_PUBLIC_BITCOIN_NETWORK:options.network??'testnet'}},require(name){
  if(name==='@/lib/bitcoin-test-network')return networkContext.exports;
  if(name==='@/lib/escrow-protocol')return {isLegacyEscrowProtocol:value=>value==='legacy_v1'};
  if(name==='next/server')return {NextResponse:{json:(body,opts={})=>({body,status:opts.status??200})}};
  if(name==='@/lib/supabase/server')return {createClient:async()=>({auth:{getUser:async()=>({data:{user:options.guest?null:{id:options.actor??'buyer'}}})},from(){return {select(){return this},eq(){return this},maybeSingle:async()=>({data:order,error:options.orderReadError?{}:null})}}})};
  if(name==='@/lib/supabase/admin')return {createAdminClient:()=>({rpc:async(name,args)=>{
   assert.equal(name,'confirm_order_funding_snapshot');writes.push(args);
   return {data:options.badAck?{}:{ok:true},error:options.sqlError?{message:'synthetic failure'}:null};
  }})};
  if(name==='@/lib/bitcoin')return {rpc:async(method)=>{
   reads.push(method);
   if(method==='getblockchaininfo')return {chain:options.chain??'test'};
   if(method==='listunspent')return options.utxos??[{txid:'a'.repeat(64),vout:2,amount:0.00104,confirmations:2,...options.utxo}];
   if(method==='getreceivedbyaddress')return options.shipping??0.00001;
   if(method==='getblockcount')return options.tip??101;
   throw Error('Forbidden Bitcoin method '+method);
  }};
  throw Error('Forbidden module '+name);
 }};
 vm.runInNewContext(code,context);return {...await context.exports.POST({}, {params:Promise.resolve({id:'order'})}),writes,reads};
}
let count=0;
for(const actor of ['buyer','seller']){
 const r=await run({actor});assert.equal(r.status,200);assert.equal(r.writes.length,1);
 const args=r.writes[0];assert.equal(args.p_actor,actor);assert.equal(args.p_height,100);
 assert.equal(args.p_expected.escrow_descriptor,'saved-policy');assert.equal(args.p_expected.price_sats,'100000');
 assert.equal(args.p_escrow_sats,104000);assert.equal(args.p_shipping_sats,1000);count++;
}
for(const options of [{guest:true},{actor:'other'},{order:{status:'FUNDED'}},{order:{escrow_protocol:'escrow_v2'}},
 {order:{buyer_commission_sats:null}},{order:{expires_at:'2000-01-01'}},
 {utxo:{txid:'bad'}},{utxo:{vout:-1}},{utxo:{confirmations:0}},
 {utxo:{confirmations:999}},{tip:0.5},{shipping:0},
 {utxos:[]},{utxo:{amount:0.002}}]){
 const r=await run(options);assert.equal(r.writes.length,0);count++;
}
for(const options of [{sqlError:true},{badAck:true}]){
 const r=await run(options);assert.equal(r.status,503);assert.equal(r.body.requiresReview,true);
 assert.match(r.body.message,/Do not send another payment/);count++;
}
for(const options of [{chain:'regtest'},{chain:'main'},{chain:'testnet4'},{network:'bitcoin'},{network:'invalid'}]){
 const r=await run(options);assert.equal(r.status,503);assert.equal(r.writes.length,0);
 assert.ok(r.reads.every(method=>method==='getblockchaininfo'));count++;
}
const unavailable=await run({orderReadError:true});assert.equal(unavailable.status,503);
assert.equal(unavailable.writes.length,0);assert.equal(unavailable.reads.length,0);
assert.match(unavailable.body.error,/Do not send another payment/);count++;
console.log(`PASS: ${count} isolated funding route checks. RPC reads simulated; no Bitcoin signing or broadcast modules loaded.`);
