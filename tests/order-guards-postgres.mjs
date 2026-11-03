import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// Called only inside the runner's freshly created, verified synthetic cluster.
export async function runOrderGuardTests(db,root){
 await db.query(`
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
 $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
 CREATE TABLE public.orders(id uuid PRIMARY KEY,listing_id uuid,status text,closed_at timestamptz,updated_at timestamptz);
 CREATE TABLE public.disputes(id uuid PRIMARY KEY,order_id uuid,arbiter_id uuid,status text,decision text,decision_notes text,decided_at timestamptz,fee_eur_cents integer);
 CREATE TABLE public.listings(id uuid PRIMARY KEY,status text);
 CREATE TABLE public.arbiters(user_id uuid PRIMARY KEY,cases_decided integer);
 CREATE TABLE public.order_events(order_id uuid,actor_id uuid,actor_role text,type text,data jsonb);
 `);
 await db.query(fs.readFileSync(path.join(root,'supabase/security/fix-dispute-validation.sql'),'utf8'));
 const actor='00000000-0000-4000-8000-000000000001';
 const other='00000000-0000-4000-8000-000000000002';
 const id='00000000-0000-4000-8000-000000000003';
 await db.query(`INSERT INTO orders(id,listing_id,status) VALUES($1,$1,'DISPUTED');
 `,[id]);
 await db.query("INSERT INTO disputes(id,order_id,arbiter_id,status,fee_eur_cents) VALUES($1,$1,$2,'assigned',50)",[id,actor]);
 await db.query("INSERT INTO listings VALUES($1,'reserved')",[id]);
 await db.query('INSERT INTO arbiters VALUES($1,0)',[actor]);
 const snapshot=async()=> (await db.query(`SELECT jsonb_build_object(
 'orders',(SELECT jsonb_agg(o) FROM orders o),
 'disputes',(SELECT jsonb_agg(d) FROM disputes d),
 'listings',(SELECT jsonb_agg(l) FROM listings l),
 'arbiters',(SELECT jsonb_agg(a) FROM arbiters a),
 'events',(SELECT jsonb_agg(e) FROM order_events e)) AS value`)).rows[0].value;
 const initial=await snapshot();let count=0;
 const call=(decision,notes)=>db.query('SELECT public.decide_dispute($1,$2,$3)',[id,decision,notes]);
 await db.query("SELECT set_config('test.actor',$1,false)",[actor]);
 for(const [decision,notes] of [[null,'a valid explanation'],['invalid','a valid explanation'],['seller',null],['buyer','short'],['buyer','          ']]){
  await assert.rejects(()=>call(decision,notes),e=>e.code==='P0001');
  assert.deepEqual(await snapshot(),initial);count++;
 }
 for(const who of [other,'']){
  await db.query("SELECT set_config('test.actor',$1,false)",[who]);
  await assert.rejects(()=>call('buyer','a valid explanation'),e=>e.code==='P0001');
  assert.deepEqual(await snapshot(),initial);count++;
 }
 await db.query("SELECT set_config('test.actor',$1,false)",[actor]);
 for(const decision of ['seller','buyer']){
  await db.query('BEGIN');
  await call(decision,'  a valid explanation  ');
  const state=await snapshot();
  assert.equal(state.orders[0].status,decision==='seller'?'COMPLETED':'REFUNDED');
  assert.equal(state.listings[0].status,decision==='seller'?'sold':'active');
  assert.equal(state.disputes[0].decision,decision);
  assert.equal(state.disputes[0].decision_notes,'a valid explanation');
  assert.equal(state.arbiters[0].cases_decided,1);assert.equal(state.events.length,1);
  await db.query('SAVEPOINT retry');
  await assert.rejects(()=>call(decision,'another explanation'),e=>e.code==='P0001');
  await db.query('ROLLBACK TO SAVEPOINT retry');assert.deepEqual(await snapshot(),state);
  await db.query('ROLLBACK');count++;
 }
 const acl=(await db.query(`SELECT has_function_privilege('anon','public.decide_dispute(uuid,text,text)','EXECUTE') AS anon,
 has_function_privilege('authenticated','public.decide_dispute(uuid,text,text)','EXECUTE') AS authenticated`)).rows[0];
 assert.deepEqual(acl,{anon:false,authenticated:true});count++;
 // Test ALTER against existing functions; never execute the simulation bodies.
 for(const name of ['simulate_payment','simulate_delivery','test_expire_window']){
  await db.query(`CREATE FUNCTION public.${name}(uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RAISE EXCEPTION 'Must not execute'; END $$`);
 }
 const before=(await db.query("SELECT oid,prosrc,proacl FROM pg_proc WHERE proname IN ('simulate_payment','simulate_delivery','test_expire_window') ORDER BY oid")).rows;
 await db.query(fs.readFileSync(path.join(root,'supabase/security/harden-simulation-search-path.sql'),'utf8'));
 const after=(await db.query("SELECT oid,prosrc,proacl,proconfig FROM pg_proc WHERE proname IN ('simulate_payment','simulate_delivery','test_expire_window') ORDER BY oid")).rows;
 for(let i=0;i<before.length;i++){
  const {proconfig,...rest}=after[i];assert.deepEqual(rest,before[i]);
  assert.deepEqual(proconfig,['search_path=pg_catalog, public, pg_temp']);count++;
 }
 assert.deepEqual(await snapshot(),initial);
 console.log(`PASS: ${count} focused PostgreSQL guard checks; synthetic rows only, no Bitcoin calls or simulation execution.`);
}
