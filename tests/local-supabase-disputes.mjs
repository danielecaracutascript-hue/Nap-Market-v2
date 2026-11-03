import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';

export async function runLocalDisputes({admin,buyer,seller,stranger,makeUser,sql,root,anonymous,runtime}){
 sql(fs.readFileSync(path.join(root,'tests/fixtures/local-supabase-lifecycle.sql'),'utf8'));
 sql(fs.readFileSync(path.join(root,'tests/fixtures/local-supabase-disputes.sql'),'utf8'));
 for(const file of ['fix-open-dispute-validation.sql','fix-dispute-validation.sql'])sql(fs.readFileSync(path.join(root,'supabase/security',file),'utf8'));
 sql("NOTIFY pgrst, 'reload schema';");
 for(let attempt=0;attempt<30;attempt++){
  const result=await admin.from('arbiters').select('user_id').limit(1);
  if(!result.error)break;if(attempt===29)throw Error('Dispute schema cache unavailable');
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 const arbiter=await makeUser(),otherArbiter=await makeUser();
 assert.equal((await admin.from('profiles').insert([{id:arbiter.id},{id:otherArbiter.id}])).error,null);
 // This entire dedicated table is synthetic. Preserve rows/counters, but disable
 // previous fixture candidates so assignment is reproducible on subsequent runs.
 assert.equal((await admin.from('arbiters').update({active:false}).neq('user_id','00000000-0000-0000-0000-000000000000')).error,null);
 assert.equal((await admin.from('arbiters').upsert([
  {user_id:buyer.id,active:true,last_assigned_at:'2000-01-01'},
  {user_id:seller.id,active:true,last_assigned_at:'2000-01-01'},
  {user_id:arbiter.id,active:true,last_assigned_at:'2001-01-01'},
  {user_id:otherArbiter.id,active:false,last_assigned_at:'1999-01-01'},
 ])).error,null);
 const req=createRequire(path.join(root,'package.json')),ts=req('typescript');
 const code=ts.transpileModule(fs.readFileSync(path.join(root,'lib/escrow.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 const context={exports:{},process:{env:{NEXT_PUBLIC_BITCOIN_NETWORK:'regtest'}},require(){throw Error('No wallet/crypto imports allowed for refund classification')}};
 vm.runInNewContext(code,context);const policy=context.exports;
 let checks=0;
 async function order(status='DELIVERED',extra={}){
  const id=randomUUID(),listing_id=randomUUID();
  assert.equal((await admin.from('listings').insert({id:listing_id,status:'reserved'})).error,null);
  assert.equal((await admin.from('orders').insert({id,listing_id,buyer_id:buyer.id,seller_id:seller.id,status,
   price_sats:100000,buyer_commission_sats:4000,shipping_sats:1000,escrow_index:44,
   expires_at:new Date(Date.now()+86400000).toISOString(),window_ends_at:new Date(Date.now()+86400000).toISOString(),...extra})).error,null);
  return id;
 }
 async function snapshot(id){
  const o=await admin.from('orders').select('*').eq('id',id).single();assert.equal(o.error,null);
  const d=await admin.from('disputes').select('*').eq('order_id',id);assert.equal(d.error,null);
  const e=await admin.from('order_events').select('*').eq('order_id',id);assert.equal(e.error,null);
  const a=await admin.from('arbiters').select('*').in('user_id',[arbiter.id,otherArbiter.id]);assert.equal(a.error,null);
  const l=await admin.from('listings').select('*').eq('id',o.data.listing_id).single();assert.equal(l.error,null);
  return {order:o.data,disputes:d.data,events:e.data.map(event=>JSON.stringify(event)).sort(),arbiters:a.data.sort((x,y)=>x.user_id.localeCompare(y.user_id)),listing:l.data};
 }
 const openArgs=id=>({p_order:id,p_reason:'other',p_description:'  A synthetic dispute description  '});
 async function denied(id,client,name,args,code='P0001'){
  const before=await snapshot(id);const result=await client.rpc(name,args);
  assert.equal(result.error?.code,code);assert.deepEqual(await snapshot(id),before);checks++;
 }
 async function visible(client,table,id,expected){
  const result=await client.from(table).select('*').eq(table==='orders'?'id':'order_id',id);
  assert.equal(result.error,null);assert.equal(result.data.length,expected);checks++;
 }
 const id=await order();
 await denied(id,stranger.client,'open_dispute',openArgs(id));
 await denied(id,seller.client,'open_dispute',openArgs(id));
 await denied(id,buyer.client,'open_dispute',{...openArgs(id),p_reason:null});
 await denied(id,buyer.client,'open_dispute',{...openArgs(id),p_description:null});
 const opened=await buyer.client.rpc('open_dispute',openArgs(id));assert.equal(opened.error,null);checks++;
 const disputeId=opened.data;let current=await snapshot(id);
 assert.equal(current.order.status,'DISPUTED');assert.equal(current.disputes[0].arbiter_id,arbiter.id);
 assert.equal(current.disputes[0].status,'assigned');assert.equal(current.disputes[0].description,'A synthetic dispute description');checks++;
 await denied(id,buyer.client,'open_dispute',openArgs(id));
 for(const client of [buyer.client,seller.client,arbiter.client]){
  await visible(client,'orders',id,1);await visible(client,'disputes',id,1);await visible(client,'order_events',id,1);
 }
 for(const client of [stranger.client,otherArbiter.client]){
  await visible(client,'orders',id,0);await visible(client,'disputes',id,0);await visible(client,'order_events',id,0);
 }
 const decision={p_dispute:disputeId,p_decision:'buyer',p_notes:'  A synthetic justified decision  '};
 for(const client of [buyer.client,seller.client,stranger.client,otherArbiter.client])await denied(id,client,'decide_dispute',decision);
 await denied(id,arbiter.client,'decide_dispute',{...decision,p_decision:null});
 await denied(id,arbiter.client,'decide_dispute',{...decision,p_notes:null});
 const decided=await arbiter.client.rpc('decide_dispute',decision);assert.equal(decided.error,null);checks++;
 current=await snapshot(id);assert.equal(current.order.status,'REFUNDED');assert.equal(current.listing.status,'active');
 assert.equal(current.disputes[0].decision_notes,'A synthetic justified decision');
 assert.equal(current.arbiters.find(row=>row.user_id===arbiter.id).cases_decided,1);
 assert.equal(current.events.filter(row=>JSON.parse(row).type==='dispute_decided').length,1);checks++;
 await denied(id,arbiter.client,'decide_dispute',decision);
 const directWrite=await stranger.client.from('arbiters').insert({user_id:stranger.id,active:true});
 assert.equal(directWrite.error?.code,'42501');checks++;

 // A seller can open a dispute about a shipped return; buyer commission stays.
 const returnId=await order('RETURN_SHIPPED');
 assert.equal((await admin.from('order_events').insert({order_id:returnId,actor_id:buyer.id,actor_role:'buyer',type:'return_requested',data:{}})).error,null);
 const returned=await seller.client.rpc('open_dispute',openArgs(returnId));assert.equal(returned.error,null);checks++;
 const win=await arbiter.client.rpc('decide_dispute',{...decision,p_dispute:returned.data});assert.equal(win.error,null);checks++;
 const refundEvents=await admin.from('order_events').select('type,data').eq('order_id',returnId);assert.equal(refundEvents.error,null);
 const kind=policy.refundKindFromEvents(refundEvents.data);assert.equal(kind,'return');
 assert.equal(policy.refundAmounts({price_sats:100000,buyer_commission_sats:4000,seller_commission_sats:4000},kind).platform,4000);checks++;

 const sellerWin=await order();const sellerCase=await buyer.client.rpc('open_dispute',openArgs(sellerWin));assert.equal(sellerCase.error,null);
 const sellerResult=await arbiter.client.rpc('decide_dispute',{...decision,p_dispute:sellerCase.data,p_decision:'seller'});assert.equal(sellerResult.error,null);
 const completed=await snapshot(sellerWin);assert.equal(completed.order.status,'COMPLETED');assert.equal(completed.listing.status,'sold');checks++;
 const expired=await order('DELIVERED',{window_ends_at:'2000-01-01T00:00:00Z'});
 await denied(expired,buyer.client,'open_dispute',openArgs(expired));
 const unknown=await order('DELIVERED',{window_ends_at:null});await denied(unknown,buyer.client,'open_dispute',openArgs(unknown));
 const raceId=await order();const raceCase=await buyer.client.rpc('open_dispute',openArgs(raceId));assert.equal(raceCase.error,null);
 const beforeRace=await snapshot(raceId);
 const race=await Promise.all([
  arbiter.client.rpc('decide_dispute',{...decision,p_dispute:raceCase.data,p_decision:'buyer'}),
  arbiter.client.rpc('decide_dispute',{...decision,p_dispute:raceCase.data,p_decision:'seller'}),
 ]);
 assert.deepEqual(race.map(result=>result.error?.code??'ok').sort(),['P0001','ok']);
 const afterRace=await snapshot(raceId);
 assert.equal(afterRace.events.filter(row=>JSON.parse(row).type==='dispute_decided').length,1);
 assert.equal(afterRace.arbiters.find(row=>row.user_id===arbiter.id).cases_decided,
  beforeRace.arbiters.find(row=>row.user_id===arbiter.id).cases_decided+1);checks++;
 assert.equal((await admin.from('arbiters').update({active:false}).in('user_id',[arbiter.id,otherArbiter.id])).error,null);
 const queuedId=await order();const queued=await buyer.client.rpc('open_dispute',openArgs(queuedId));assert.equal(queued.error,null);
 const waiting=await snapshot(queuedId);assert.equal(waiting.disputes[0].arbiter_id,null);
 assert.equal(waiting.disputes[0].status,'open');assert.equal(waiting.order.status,'DISPUTED');checks++;
 await denied(queuedId,arbiter.client,'decide_dispute',{...decision,p_dispute:queued.data});
 await visible(arbiter.client,'orders',queuedId,0);await visible(stranger.client,'orders',queuedId,0);
 await denied(id,anonymous,'open_dispute',openArgs(id),'42501');
 await denied(id,anonymous,'decide_dispute',decision,'42501');
 // Leave new synthetic candidates inactive for later independent test runs.
 assert.equal((await admin.from('arbiters').update({active:false}).in('user_id',[buyer.id,seller.id,arbiter.id,otherArbiter.id])).error,null);
 fs.writeFileSync(path.join(runtime,'dispute-integration-report.json'),JSON.stringify({checks,real:['Auth','PostgREST/RLS','PostgreSQL','reviewed dispute functions'],syntheticOrderId:id,bitcoinOperations:0,policy:'return commission retained after buyer wins dispute'},null,2));
 console.log(`PASS: ${checks} real local Supabase dispute checks. Assignment, RLS isolation, decisions, return commission and invalid inputs. Synthetic rows only; no Bitcoin operations.`);
}
