import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// Synthetic schema only, within the runner's verified new local cluster.
export async function runOpenDisputeTests(db,root){
 await db.query(`
 CREATE ROLE postgres NOSUPERUSER NOBYPASSRLS;
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 GRANT USAGE,CREATE ON SCHEMA public TO postgres;
 GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
 CREATE SCHEMA auth AUTHORIZATION postgres;
 SET ROLE postgres;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
 $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
 CREATE TABLE orders(id uuid PRIMARY KEY,buyer_id uuid,seller_id uuid,status text,window_ends_at timestamptz,updated_at timestamptz);
 CREATE TABLE disputes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid,opened_by uuid,reason text,description text,arbiter_id uuid,status text);
 CREATE TABLE arbiters(user_id uuid PRIMARY KEY,active boolean,last_assigned_at timestamptz);
 CREATE TABLE order_events(order_id uuid,actor_id uuid,actor_role text,type text,data jsonb);
 `);
 const script=fs.readFileSync(path.join(root,'supabase/security/fix-open-dispute-validation.sql'),'utf8');
 const metadata=(await db.query(script)).at(-1).rows[0];
 assert.deepEqual(metadata,{function_name:'open_dispute',settings:['search_path=pg_catalog, public, pg_temp'],anon:false,authenticated:true,service_role:true});
 // Check repeat installation without changing routine ACL or signature.
 assert.deepEqual((await db.query(script)).at(-1).rows[0],metadata);
 const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const [id,buyer,seller,arb,inactive,outsider]=[1,2,3,4,5,6].map(uid);
 await db.query("INSERT INTO orders VALUES($1,$2,$3,'DELIVERED',now()+interval '1 day',NULL)",[id,buyer,seller]);
 for(const [user,active,date] of [[buyer,true,'2000-01-01'],[seller,true,'2000-01-01'],[arb,true,'2001-01-01'],[inactive,false,'1999-01-01']]){
  await db.query('INSERT INTO arbiters VALUES($1,$2,$3)',[user,active,date]);
 }
 const snapshot=async()=> (await db.query(`SELECT jsonb_build_object(
 'orders',(SELECT jsonb_agg(o ORDER BY id) FROM orders o),
 'disputes',(SELECT jsonb_agg(d ORDER BY id) FROM disputes d),
 'arbiters',(SELECT jsonb_agg(a ORDER BY user_id) FROM arbiters a),
 'events',(SELECT jsonb_agg(e) FROM order_events e)) AS value`)).rows[0].value;
 let count=2;
 const actor=who=>db.query("SELECT set_config('test.actor',$1,false)",[who]);
 const call=(reason='other',description='a valid description')=>db.query('SELECT public.open_dispute($1,$2,$3) AS id',[id,reason,description]);
 const test=async(name,action)=>{
  await db.query('BEGIN');
  try{await action();console.log('PASS: '+name);count++}finally{await db.query('ROLLBACK')}
 };
 const rejectUnchanged=async(action,message)=>{
  const before=await snapshot();await db.query('SAVEPOINT invalid');
  await assert.rejects(action,e=>e.code==='P0001'&&(!message||e.message===message));
  await db.query('ROLLBACK TO SAVEPOINT invalid');assert.deepEqual(await snapshot(),before);
 };
 await actor(buyer);
 for(const [reason,description] of [[null,'a valid description'],['invalid','a valid description'],['other',null],['other','short'],['other','          ']]){
  await test('reject invalid reason/description without writes',()=>rejectUnchanged(()=>call(reason,description)));
 }
 for(const who of ['',outsider]){
  await test('reject absent/foreign participant',async()=>{await actor(who);await rejectUnchanged(()=>call())});
 }
 for(const [status,deadline,who] of [
  ['DELIVERED',null,buyer],['DELIVERED','2000-01-01',buyer],
  [null,'2099-01-01',buyer],['FUNDED','2099-01-01',buyer],
  ['RETURN_SHIPPED',null,buyer],['DELIVERED','2099-01-01',seller]
 ]){
  await test('reject ineligible status/deadline/participant role',async()=>{
   await actor(who);await db.query('UPDATE orders SET status=$1,window_ends_at=$2',[status,deadline]);
   await rejectUnchanged(()=>call());
  });
 }
 for(const who of [buyer,seller]){
  await test('valid participant gets independent active arbiter and single event',async()=>{
   await actor(who);if(who===seller)await db.query("UPDATE orders SET status='RETURN_SHIPPED',window_ends_at=NULL");
   const result=await call('other','  a valid description  ');assert.ok(result.rows[0].id);
   const state=await snapshot();assert.equal(state.orders[0].status,'DISPUTED');
   assert.equal(state.disputes[0].arbiter_id,arb);assert.equal(state.disputes[0].status,'assigned');
   assert.equal(state.disputes[0].opened_by,who);assert.equal(state.disputes[0].description,'a valid description');
   assert.equal(state.events.length,1);assert.equal(state.events[0].actor_role,who===buyer?'buyer':'seller');
   assert.equal(state.events[0].data.arbiter_assigned,true);
   await rejectUnchanged(()=>call());
  });
 }
 await test('no available independent arbiter leaves dispute open',async()=>{
  await actor(buyer);await db.query('UPDATE arbiters SET active=false WHERE user_id=$1',[arb]);
  await call();const state=await snapshot();
  assert.equal(state.disputes[0].arbiter_id,null);assert.equal(state.disputes[0].status,'open');
  assert.equal(state.events[0].data.arbiter_assigned,false);
 });
 await test('existing open dispute blocks duplicate without writes',async()=>{
  await actor(buyer);await db.query("INSERT INTO disputes(order_id,status) VALUES($1,'open')",[id]);
  await rejectUnchanged(()=>call(),'A dispute is already open for this order');
 });
 await test('anonymous execution denied at privilege boundary',async()=>{
  await db.query('SET LOCAL ROLE anon');await db.query('SAVEPOINT denied');
  await assert.rejects(()=>call(),e=>e.code==='42501');await db.query('ROLLBACK TO SAVEPOINT denied');
 });
 await test('authenticated execution succeeds through definer without table grants',async()=>{
  await actor(buyer);await db.query('SET LOCAL ROLE authenticated');await call();
  await db.query('SET LOCAL ROLE postgres');assert.equal((await snapshot()).disputes.length,1);
 });
 console.log(`PASS: ${count} focused PostgreSQL open-dispute checks. No remote database or Bitcoin calls.`);
}
