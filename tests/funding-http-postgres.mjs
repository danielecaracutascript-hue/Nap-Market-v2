import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setupFundingSnapshotFixture} from './funding-snapshot-postgres.mjs';

// Actual Supabase SDK + HTTP + PostgreSQL. The HTTP adapter below is a test
// double, NOT PostgREST or GoTrue. Session/cookie authentication is not tested.
export async function runFundingHttpTests(db,root,connect){
 const fixture=await setupFundingSnapshotFixture(db,root);
 const {id,buyer,seller,other,txid}=fixture;
 await db.query(`RESET ROLE;
 CREATE SCHEMA auth AUTHORIZATION postgres;
 SET ROLE postgres;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
 $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
 GRANT USAGE ON SCHEMA auth TO authenticated;
 GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
 GRANT SELECT ON orders TO authenticated;
 ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
 CREATE POLICY participant_read ON orders FOR SELECT TO authenticated
 USING (buyer_id=auth.uid() OR seller_id=auth.uid());`);
 const reader=await connect(),writer=await connect();
 const req=createRequire(path.join(root,'package.json'));
 const sdk=req('@supabase/supabase-js'),ts=req('typescript');
 const counters={reads:0,rpcs:0},faults={};
 let actor=buyer;
 const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))};
 const server=http.createServer(async(request,response)=>{
  try{
   const url=new URL(request.url,'http://localhost');
   if(request.method==='GET'&&url.pathname==='/rest/v1/orders'){
    assert.equal(request.headers.authorization,'Bearer synthetic-session');
    assert.equal(url.searchParams.get('id'),'eq.'+id);counters.reads++;
    await reader.query('BEGIN');
    try{
     await reader.query("SELECT set_config('test.actor',$1,true)",[actor]);
     await reader.query('SET LOCAL ROLE authenticated');
     // row_to_json retains PostgreSQL timestamp microseconds; pg's Date parser
     // would truncate them and manufacture a false snapshot mismatch.
     const data=(await reader.query('SELECT row_to_json(o) AS value FROM public.orders o WHERE id=$1',[id])).rows.map(row=>row.value);
     await reader.query('COMMIT');json(response,200,data);
    }catch(error){await reader.query('ROLLBACK');throw error}
    return;
   }
   if(request.method==='POST'&&url.pathname==='/rest/v1/rpc/confirm_order_funding_snapshot'){
    assert.equal(request.headers.authorization,'Bearer synthetic-service');counters.rpcs++;
    let body='';for await(const chunk of request)body+=chunk;
    const args=JSON.parse(body);
    if(faults.missingRpc){json(response,404,{code:'PGRST202',message:'Synthetic missing schema-cache entry',details:null,hint:null});return}
    await writer.query('BEGIN');
    let result;
    try{
     await writer.query('SET LOCAL ROLE service_role');
     result=(await writer.query('SELECT public.confirm_order_funding_snapshot($1,$2,$3,$4,$5,$6,$7,$8::jsonb) AS value',[
      args.p_order,args.p_actor,args.p_txid,args.p_vout,args.p_height,args.p_escrow_sats,args.p_shipping_sats,args.p_expected,
     ])).rows[0].value;
     await writer.query('COMMIT');
    }catch(error){
     await writer.query('ROLLBACK');
     faults.lastSqlError={code:error.code,message:error.message};
     json(response,400,{code:error.code,message:error.message,details:null,hint:null});return;
    }
    if(faults.lostAck){response.destroy();return}
    json(response,200,result);return;
   }
   json(response,404,{message:'Unexpected synthetic endpoint'});
  }catch(error){json(response,500,{message:error.message})}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 // Neither the actual user environment nor the app's .env files are loaded.
 const syntheticEnv={NEXT_PUBLIC_SUPABASE_URL:base,SUPABASE_SECRET_KEY:'synthetic-service'};
 const guardedSdk={createClient(url,key,options){
  assert.equal(url,base);
  return sdk.createClient(url,key,{...options,global:{fetch:async(url,options)=>{
   assert.equal(new URL(url).origin,base,'Refusing non-local HTTP destination');
   return fetch(url,options);
  }}});
 }};
 function load(file,resolve,globals={}){
  const code=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017}}).outputText;
  const context={exports:{},require:resolve,...globals};vm.runInNewContext(code,context);return context.exports;
 }
 const admin=load('lib/supabase/admin.ts',name=>{
  if(name==='server-only')return {};assert.equal(name,'@supabase/supabase-js');return guardedSdk;
 },{process:{env:syntheticEnv}});
 const session=guardedSdk.createClient(base,'synthetic-session',{auth:{persistSession:false,autoRefreshToken:false}});
 const networkPolicy=load('lib/bitcoin-test-network.ts',()=>{throw Error('Unexpected import')});
 const route=load('app/api/orders/[id]/check-payment/route.ts',name=>{
  if(name==='@/lib/bitcoin-test-network')return networkPolicy;
  if(name==='next/server')return {NextResponse:{json:(body,options={})=>({body,status:options.status??200})}};
  if(name==='@/lib/supabase/admin')return admin;
  if(name==='@/lib/supabase/server')return {createClient:async()=>({
   auth:{getUser:async()=>({data:{user:actor?{id:actor}:null}})},
   from:table=>session.from(table),
  })};
  if(name==='@/lib/bitcoin')return {rpc:async method=>{
   if(method==='getblockchaininfo')return {chain:'regtest'};
   if(method==='listunspent')return [{txid,vout:2,amount:0.00104,confirmations:2}];
   if(method==='getreceivedbyaddress')return 0.00001;
   if(method==='getblockcount'){
    if(faults.changePrice)await db.query('UPDATE public.orders SET price_sats=price_sats+1');
    return 101;
   }
   throw Error('Forbidden Bitcoin call '+method);
  }};
  throw Error('Forbidden module '+name);
 },{process:{env:{NEXT_PUBLIC_BITCOIN_NETWORK:'regtest'}}});
 const call=()=>route.POST({}, {params:Promise.resolve({id})});
 const state=async()=> (await db.query(`SELECT status,funding_txid,
 (SELECT count(*)::integer FROM order_events) AS events FROM orders`)).rows[0];
 const reset=async()=>{
  await db.query("UPDATE orders SET status='CREATED',price_sats=100000,funding_txid=NULL,funding_vout=NULL,funding_height=NULL,funded_at=NULL,updated_at=NULL;DELETE FROM order_events");
  for(const key of Object.keys(faults))delete faults[key];actor=buyer;
 };
 let count=0;
 try{
  for(const who of [buyer,seller]){
   await reset();actor=who;const result=await call();assert.equal(result.status,200,JSON.stringify({result,faults}));
   assert.deepEqual(await state(),{status:'FUNDED',funding_txid:txid,events:1});count++;
   const before=counters.rpcs;assert.equal((await call()).status,200);
   assert.equal(counters.rpcs,before);assert.equal((await state()).events,1);count++;
  }
  for(const who of ['',other]){
   await reset();actor=who;const before=counters.rpcs;
   assert.equal((await call()).status,who?404:401);assert.equal(counters.rpcs,before);
   assert.deepEqual(await state(),{status:'CREATED',funding_txid:null,events:0});count++;
  }
  for(const fault of ['changePrice','missingRpc']){
   await reset();faults[fault]=true;const result=await call();
   assert.equal(result.status,503);assert.equal(result.body.requiresReview,true);
   assert.deepEqual(await state(),{status:'CREATED',funding_txid:null,events:0});count++;
  }
  await reset();faults.lostAck=true;const uncertain=await call();
  assert.equal(uncertain.status,503);assert.equal(uncertain.body.requiresReview,true);
  assert.match(uncertain.body.message,/Do not send another payment/);
  assert.deepEqual(await state(),{status:'FUNDED',funding_txid:txid,events:1});count++;
  faults.lostAck=false;assert.equal((await call()).status,200);
  assert.equal((await state()).events,1);count++;
  console.log(`PASS: ${count} integrated funding HTTP/SDK/PostgreSQL checks. Auth, REST adapter and Bitcoin are test doubles; no real Supabase or node accessed.`);
 }finally{
  await new Promise(resolve=>server.close(resolve));await reader.end();await writer.end();
 }
}
