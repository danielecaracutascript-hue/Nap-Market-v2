import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const req=createRequire(path.join(root,'package.json')),ts=req('typescript');
function load(file,resolve,env={}){
 const code=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017}}).outputText;
 const context={exports:{},require:resolve,process:{env}};vm.runInNewContext(code,context);return context.exports;
}
const policy=load('lib/escrow-legacy-policy.ts',()=>{throw Error('Unexpected import')});
const networkPolicy=load('lib/bitcoin-test-network.ts',()=>{throw Error('Unexpected import')});
const {BIP32}=req('@bitcoinerlab/descriptors'),{networks}=req('bitcoinjs-lib');
const point=Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798','hex');
// Synthetic chain codes and a public curve point; no private keys or seeds.
const key=n=>`[${String(n).repeat(8)}/84h/1h/0h]${BIP32.fromPublicKey(point,Buffer.alloc(32,n),networks.testnet).toBase58()}`;
const buyerKey=key(1),sellerKey=key(2),platformKey=key(3);
async function run(options={}){
 const rpcCalls=[],writes=[];
 const order={id:'order',buyer_id:'buyer',seller_id:'seller',status:'CREATED',escrow_protocol:'legacy_v1',escrow_index:42,escrow_address:null,expires_at:'2099-01-01',...options.order};
 const mod=load('app/api/orders/[id]/escrow/route.ts',name=>{
  if(name==='next/server')return {NextResponse:{json:(body,opts={})=>({body,status:opts.status??200})}};
  if(name==='@/lib/escrow-legacy-policy')return policy;
  if(name==='@/lib/bitcoin-test-network')return networkPolicy;
  if(name==='@/lib/escrow-protocol')return {isLegacyEscrowProtocol:value=>value==='legacy_v1'};
  if(name==='@/lib/supabase/server')return {createClient:async()=>({auth:{getUser:async()=>({data:{user:options.guest?null:{id:options.actor??'buyer'}}})},from(table){return {
   select(){return this},eq(){return this},in(){return this},
   async maybeSingle(){return {data:order,error:options.orderError?{}:null}},
   then(resolve){assert.equal(table,'profiles');resolve({data:[{id:'buyer',wallet_xpub:options.buyerKey??buyerKey},{id:'seller',wallet_xpub:sellerKey}],error:options.profileError?{}:null})},
  }}})};
  if(name==='@/lib/supabase/admin')return {createAdminClient:()=>({
   from(table){assert.equal(table,'profiles');assert.equal(options.actor??'buyer','buyer');assert.ok(!options.guest);
    return {select(columns){assert.equal(columns,'id, wallet_xpub');return this},in(column,ids){assert.equal(column,'id');assert.deepEqual(Array.from(ids),['buyer','seller']);return this},
     then(resolve){resolve({data:[{id:'buyer',wallet_xpub:options.buyerKey??buyerKey},{id:'seller',wallet_xpub:sellerKey}],error:options.profileError?{}:null})}};
   },rpc:async(name,args)=>{writes.push({name,args});return {error:options.sqlError?{}:null,data:options.badAck?{}:{ok:true,alreadyCreated:options.concurrentWinner??false}}}})};
  if(name==='@/lib/bitcoin')return {rpc:async(method,args)=>{
   rpcCalls.push(method);
   if(method==='getblockchaininfo')return {chain:options.chain??'test'};
   if(method==='getdescriptorinfo')return {issolvable:true,descriptor:args[0]};
   if(method==='deriveaddresses')return options.badAddress?[]:['synthetic-escrow'];
   if(method==='importdescriptors')return [{success:true}];
   if(method==='getnewaddress')return options.badShipping?null:'synthetic-shipping';
   throw Error('Forbidden Bitcoin RPC '+method);
  }};
  throw Error('Unexpected import '+name);
 },{PLATFORM_XPUB:platformKey,...options.env});
 return {...await mod.POST({}, {params:Promise.resolve({id:'order'})}),rpcCalls,writes};
}
let count=0;
for(const options of [{},{order:{escrow_index:0}},{order:{escrow_index:10000}}]){
 const r=await run(options);assert.equal(r.status,200);assert.equal(r.writes.length,1);
 assert.equal(r.writes[0].name,'set_order_escrow_snapshot');
 assert.equal(r.writes[0].args.p_actor,'buyer');
 assert.equal(r.writes[0].args.p_expected.escrow_index,String(options.order?.escrow_index??42));count++;
}
for(const options of [{guest:true},{actor:'seller'},{orderError:true},{profileError:true},
 {order:{status:'FUNDED'}},{order:{escrow_protocol:'escrow_v2'}},{order:{expires_at:'2000-01-01'}},{order:{expires_at:null}},
 {order:{expires_at:'invalid'}},...[-1,10001,null,1.5].map(escrow_index=>({order:{escrow_index}})),
 ...['NaN','0','65536','1.5'].map(value=>({env:{ESCROW_CONCORDATA_BLOCKS:value}})),
 {buyerKey:platformKey},{buyerKey:platformKey.replace('[33333333','[11111111')},
 {buyerKey:buyerKey+',injected()'},{buyerKey:'not-a-public-key'}]){
 const r=await run(options);assert.ok(r.status>=400);assert.equal(r.writes.length,0);
 assert.equal(r.rpcCalls.length,0,'Reject before accessing Core');count++;
}
for(const options of [{badAddress:true},{badShipping:true}]){
 const r=await run(options);assert.equal(r.status,500);assert.equal(r.writes.length,0);count++;
}
const existing=await run({order:{escrow_address:'original-address',expires_at:'2000-01-01',escrow_index:10001}});
assert.equal(existing.status,200);assert.equal(existing.rpcCalls.length,0);assert.equal(existing.writes.length,0);count++;
for(const options of [{sqlError:true},{badAck:true}]){
 const r=await run(options);assert.equal(r.status,503);assert.match(r.body.error,/Refresh the order/);count++;
}
const concurrent=await run({concurrentWinner:true});assert.equal(concurrent.status,200);
assert.match(concurrent.body.message,/stored on the order/);assert.equal(concurrent.body.address,undefined);count++;
for(const options of [{chain:'main'},{chain:'regtest'},{chain:'testnet4'},
 {env:{NEXT_PUBLIC_BITCOIN_NETWORK:'bitcoin'}},{env:{NEXT_PUBLIC_BITCOIN_NETWORK:'invalid'}}]){
 const r=await run(options);assert.equal(r.status,503);assert.equal(r.writes.length,0);
 assert.ok(r.rpcCalls.every(method=>method==='getblockchaininfo'));count++;
}
for(const [network,chain] of [['regtest','regtest'],['signet','signet']]){
 const r=await run({env:{NEXT_PUBLIC_BITCOIN_NETWORK:network},chain});assert.equal(r.status,200);count++;
}
console.log(`PASS: ${count} escrow-creation scenarios. All node operations and database writes are inert doubles; no signing modules or live services.`);
