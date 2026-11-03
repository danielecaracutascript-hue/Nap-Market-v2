import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

// Real local GoTrue, PostgREST, PostgreSQL, SSR cookies and SDK. Bitcoin
// payment responses are inert doubles; Core status/descriptors are real reads.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtime='C:\\progetti\\work\\integration-local';
const project='nap-market-isolated-20261030';
const bin='C:\\Users\\Daniele\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin';
const docker=path.join(bin,'docker.exe'),pipe='npipe:////./pipe/dockerDesktopLinuxEngine';
const coreBin=path.join(runtime,'bitcoin/runtime/bitcoin-32.1/bin/bitcoin-cli.exe');
const coreArgs=['-datadir='+path.join(runtime,'regtest-readonly'),'-regtest','-rpcport=19443'];
const req=createRequire(path.join(root,'package.json'));
const sdk=req('@supabase/supabase-js'),ssr=req('@supabase/ssr'),ts=req('typescript');
function command(exe,args,input){
 const result=spawnSync(exe,args,{encoding:'utf8',input,windowsHide:true,timeout:45000,
  env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,DOCKER_HOST:pipe},maxBuffer:8*1024*1024});
 // Never print captured stdout/stderr: status can contain local credentials.
 if(result.status!==0)throw Error('Isolated runtime command failed; captured output withheld.');
 return result.stdout;
}
const containers=command(docker,['--host',pipe,'ps','--format','{{.Names}} {{.Ports}}']);
assert.ok(containers.includes('supabase_db_'+project));
for(const line of containers.split('\n').filter(line=>line.includes(project))){
 assert.ok(!line.includes('0.0.0.0:')&&!line.includes('[::]:'),'Refusing publicly bound test service');
}
const status=JSON.parse(command(path.join(runtime,'tools/node_modules/@supabase/cli-windows-x64/bin/supabase.exe'),['status','--workdir',path.join(runtime,'stack'),'-o','json']));
const base='http://127.0.0.1:54321';assert.equal(status.API_URL,base);
const publicKey=status.PUBLISHABLE_KEY??status.ANON_KEY;
const serviceKey=status.SECRET_KEY??status.SERVICE_ROLE_KEY;
assert.ok(publicKey&&serviceKey);
let dropFundingResponse=false;
const guardedFetch=async(input,options)=>{
 const url=typeof input==='string'?input:input.url??input.href;
 assert.equal(new URL(url).origin,base,'Refusing nonlocal Supabase HTTP');
 const response=await fetch(input,options);
 if(dropFundingResponse&&new URL(url).pathname==='/rest/v1/rpc/confirm_order_funding_snapshot'){
  dropFundingResponse=false;
  await response.arrayBuffer();
  throw Error('Synthetic lost response after actual local SQL commit');
 }
 return response;
};
const createClient=(url,key,options={})=>{
 assert.equal(url,base);return sdk.createClient(url,key,{...options,
  auth:{persistSession:false,autoRefreshToken:false,...options.auth},global:{fetch:guardedFetch}});
};
const admin=createClient(base,serviceKey);
function sql(source){return command(docker,['--host',pipe,'exec','-i','supabase_db_'+project,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-f','-'],source)}
sql(fs.readFileSync(path.join(root,'tests/fixtures/local-supabase-orders.sql'),'utf8'));
for(const file of ['add-escrow-creation-snapshot.sql','add-funding-snapshot.sql'])sql(fs.readFileSync(path.join(root,'supabase/security',file),'utf8'));
for(let attempt=0;attempt<30;attempt++){
 const ready=await admin.from('orders').select('id').limit(1);
 if(!ready.error)break;
 if(attempt===29)throw Error('Local PostgREST schema cache did not become ready');
 await new Promise(resolve=>setTimeout(resolve,200));
}
async function user(){
 // Passwordless local-only link generation; no email is sent by generateLink.
 const generated=await admin.auth.admin.generateLink({type:'magiclink',email:`nap-${randomUUID()}@example.test`});
 if(generated.error)throw Error('Local synthetic user link generation failed');
 const client=createClient(base,publicKey);
 const verificationType=generated.data.properties.verification_type;
 assert.ok(['signup','magiclink'].includes(verificationType));
 const verified=await client.auth.verifyOtp({type:verificationType,token_hash:generated.data.properties.hashed_token});
 if(verified.error||!verified.data.session)throw Error('Local synthetic user login failed: '+(verified.error?.code??'missing_session'));
 const cookies=new Map();
 const sessionClient=ssr.createServerClient(base,publicKey,{global:{fetch:guardedFetch},cookies:{
  getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:values=>values.forEach(({name,value})=>cookies.set(name,value)),
 }});
 const saved=await sessionClient.auth.setSession(verified.data.session);
 if(saved.error)throw Error('Local SSR session setup failed');
 return {id:verified.data.user.id,cookies,client};
}
const buyer=await user(),seller=await user(),stranger=await user();
let current=buyer;
function load(file,resolve,extra={}){
 const source=fs.readFileSync(path.join(root,file),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017}}).outputText;
 const context={exports:{},require:resolve,...extra};vm.runInNewContext(code,context);return context.exports;
}
const syntheticEnv={NEXT_PUBLIC_SUPABASE_URL:base,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:publicKey,SUPABASE_SECRET_KEY:serviceKey};
const serverFactory=load('lib/supabase/server.ts',name=>{
 if(name==='@supabase/ssr')return {createServerClient:(url,key,options)=>ssr.createServerClient(url,key,{...options,global:{fetch:guardedFetch}})};
 if(name==='next/headers')return {cookies:async()=>({getAll:()=>[...current.cookies].map(([name,value])=>({name,value})),set:(name,value)=>current.cookies.set(name,value)})};
 throw Error('Unexpected server import');
},{process:{env:syntheticEnv}});
const adminFactory=load('lib/supabase/admin.ts',name=>{
 if(name==='server-only')return {};if(name==='@supabase/supabase-js')return {createClient};throw Error('Unexpected admin import');
},{process:{env:syntheticEnv}});
const policy=load('lib/escrow-legacy-policy.ts',()=>{throw Error('Unexpected policy import')});
const networkPolicy=load('lib/bitcoin-test-network.ts',()=>{throw Error('Unexpected network import')});
const {BIP32}=req('@bitcoinerlab/descriptors'),{networks}=req('bitcoinjs-lib');
const point=Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798','hex');
const key=n=>BIP32.fromPublicKey(point,Buffer.alloc(32,n),networks.testnet).toBase58();
assert.equal((await admin.from('profiles').insert([{id:buyer.id,wallet_xpub:key(1)},{id:seller.id,wallet_xpub:key(2)}])).error,null);
if(process.argv.includes('--profile-privacy')){
 sql(fs.readFileSync(path.join(root,'tests/fixtures/local-profile-privacy.sql'),'utf8'));
 sql(fs.readFileSync(path.join(root,'supabase/security/separate-public-profiles.sql'),'utf8'));
 for(let attempt=0;attempt<30;attempt++){
  const ready=await admin.from('public_profiles').select('id').limit(1);if(!ready.error)break;
  if(attempt===29)throw Error('Local public profile projection unavailable');await new Promise(resolve=>setTimeout(resolve,200));
 }
 const anonymous=createClient(base,publicKey);
 const anonymousFull=await anonymous.from('profiles').select('*');
 assert.ok(anonymousFull.error?.code==='42501'||(!anonymousFull.error&&anonymousFull.data.length===0));
 const own=await buyer.client.from('profiles').select('id,wallet_xpub');assert.equal(own.error,null);assert.equal(own.data.length,1);assert.equal(own.data[0].id,buyer.id);
 const other=await buyer.client.from('profiles').select('id,wallet_xpub').eq('id',seller.id);assert.equal(other.error,null);assert.equal(other.data.length,0);
 const projected=await anonymous.from('public_profiles').select('*').in('id',[buyer.id,seller.id]);assert.equal(projected.error,null);assert.equal(projected.data.length,2);
 assert.ok(projected.data.every(row=>!('wallet_xpub' in row)&&!('created_at' in row)));
 const service=await admin.from('profiles').select('id,wallet_xpub').in('id',[buyer.id,seller.id]);assert.equal(service.error,null);assert.equal(service.data.length,2);
 fs.writeFileSync(path.join(runtime,'profile-privacy-http-report.json'),JSON.stringify({checks:6,realLocalAuthAndRest:true,anonymousFullProfiles:0,bitcoinSigning:false},null,2));
 console.log('PASS: 6 profile-privacy checks through real local Auth/PostgREST.');
}
const orderId=randomUUID(),txid='a'.repeat(64);let changePrice=false;
assert.equal((await admin.from('orders').insert({id:orderId,buyer_id:buyer.id,seller_id:seller.id,status:'CREATED',price_sats:100000,buyer_commission_sats:4000,shipping_sats:1000,escrow_index:42,expires_at:new Date(Date.now()+3600000).toISOString()})).error,null);
const nodeMethods=[];let derivedAddress;
const nodeDouble={rpc:async(method,args=[])=>{
 nodeMethods.push(method);
 if(['getdescriptorinfo','deriveaddresses','getblockchaininfo'].includes(method)){
  const actual=JSON.parse(command(coreBin,[...coreArgs,method,...args.map(value=>typeof value==='string'?value:JSON.stringify(value))]));
  if(method==='deriveaddresses')derivedAddress=actual[0];
  return actual;
 }
 if(method==='importdescriptors')return [{success:true}];
 if(method==='getnewaddress')return 'synthetic-shipping-address';
 if(method==='listunspent')return [{txid,vout:2,amount:0.00104,confirmations:2}];
 if(method==='getreceivedbyaddress')return 0.00001;
 if(method==='getblockcount'){
  if(changePrice){const changed=await admin.from('orders').update({price_sats:100001}).eq('id',orderId);assert.equal(changed.error,null)}
  return 101;
 }
 throw Error('Forbidden Bitcoin operation');
}};
function route(file){return load(file,name=>{
 if(name==='next/server')return req('next/server');
 if(name==='@/lib/supabase/server')return serverFactory;
 if(name==='@/lib/supabase/admin')return adminFactory;
 if(name==='@/lib/escrow-legacy-policy')return policy;
 if(name==='@/lib/bitcoin-test-network')return networkPolicy;
 if(name==='@/lib/bitcoin')return nodeDouble;
 throw Error('Forbidden route import');
},{process:{env:{PLATFORM_XPUB:key(3),NEXT_PUBLIC_BITCOIN_NETWORK:'regtest'}}})}
const creation=route('app/api/orders/[id]/escrow/route.ts');
const funding=route('app/api/orders/[id]/check-payment/route.ts');
const call=mod=>mod.POST(new Request(base),{params:Promise.resolve({id:orderId})});
const state=async()=>{
 const result=await admin.from('orders').select('*').eq('id',orderId).single();assert.equal(result.error,null);return result.data;
};
const events=async()=>{const result=await admin.from('order_events').select('type').eq('order_id',orderId);assert.equal(result.error,null);return result.data};
let checks=0;
current={cookies:new Map()};assert.equal((await call(creation)).status,401);checks++;
assert.equal((await call(funding)).status,401);assert.equal(nodeMethods.length,0);checks++;
current=stranger;assert.equal((await call(creation)).status,404);assert.equal(nodeMethods.length,0);checks++;
current=seller;assert.equal((await call(creation)).status,404);checks++;
current=buyer;assert.equal((await call(creation)).status,200);assert.match(derivedAddress,/^bcrt1/);
assert.equal((await state()).escrow_address,derivedAddress);checks++;
const before=nodeMethods.length;assert.equal((await call(creation)).status,200);assert.equal(nodeMethods.length,before);assert.equal((await events()).length,1);checks++;
current=stranger;const beforeStranger=nodeMethods.length;assert.equal((await call(funding)).status,404);assert.equal(nodeMethods.length,beforeStranger);checks++;
current=buyer;changePrice=true;const stale=await call(funding);assert.equal(stale.status,503);assert.equal((await stale.json()).requiresReview,true);assert.equal((await state()).status,'CREATED');assert.equal((await events()).length,1);checks++;
changePrice=false;assert.equal((await admin.from('orders').update({price_sats:100000}).eq('id',orderId)).error,null);
current=seller;dropFundingResponse=true;
const lostResponse=await call(funding);assert.equal(lostResponse.status,503);
assert.match((await lostResponse.json()).message,/Do not send another payment/);
assert.equal((await state()).funding_txid,txid);checks++;
assert.equal((await call(funding)).status,200);assert.equal((await events()).filter(event=>event.type==='payment_confirmed').length,1);checks++;
const functionArgs={p_order:orderId,p_actor:buyer.id,p_descriptor:'ignored',p_address:'ignored',p_shipping_address:'ignored',p_expected:{}};
for(const client of [createClient(base,publicKey),buyer.client]){
 const denied=await client.rpc('set_order_escrow_snapshot',functionArgs);assert.equal(denied.error?.code,'42501');checks++;
 const fundingDenied=await client.rpc('confirm_order_funding_snapshot',{
  p_order:orderId,p_actor:buyer.id,p_txid:txid,p_vout:2,p_height:100,
  p_escrow_sats:104000,p_shipping_sats:1000,p_expected:{},
 });assert.equal(fundingDenied.error?.code,'42501');checks++;
}
const chain=JSON.parse(command(coreBin,[...coreArgs,'getblockchaininfo']));
const network=JSON.parse(command(coreBin,[...coreArgs,'getnetworkinfo']));
assert.equal(chain.chain,'regtest');assert.equal(chain.blocks,0);assert.equal(network.networkactive,false);assert.equal(network.connections,0);checks++;
fs.writeFileSync(path.join(runtime,'orders-integration-report.json'),JSON.stringify({checks,real:['Supabase Auth','SSR cookie serialization','PostgREST','PostgreSQL','route handlers','Core public status and descriptor/address derivation'],simulated:['watch import','shipping address generation','Bitcoin payment evidence','Next cookies request context'],syntheticOrderId:orderId,bitcoinTransactions:0},null,2));
console.log(`PASS: ${checks} local Supabase/Core integration checks. Actual Auth, SSR session, PostgREST/RLS, SQL and Core descriptor/address reads. Watch import, shipping address and payment evidence simulated. No real-user credentials, signing, finalization or broadcast.`);
if(process.argv.includes('--lifecycle')){
 const {runLocalLifecycle}=await import('./local-supabase-lifecycle.mjs');
 await runLocalLifecycle({admin,buyer,seller,stranger,orderId,sql,root,anonymous:createClient(base,publicKey),runtime});
}
if(process.argv.includes('--disputes')){
 const {runLocalDisputes}=await import('./local-supabase-disputes.mjs');
 await runLocalDisputes({admin,buyer,seller,stranger,makeUser:user,sql,root,anonymous:createClient(base,publicKey),runtime});
}
