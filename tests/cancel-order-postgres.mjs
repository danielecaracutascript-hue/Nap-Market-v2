import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function runCancelOrderTests(db,root,connect){
 await db.query(`CREATE ROLE postgres LOGIN NOSUPERUSER NOBYPASSRLS;
 CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 GRANT pg_read_all_settings TO postgres;
 GRANT anon,authenticated,service_role TO postgres WITH INHERIT FALSE;
 GRANT USAGE,CREATE ON SCHEMA public TO postgres;
 GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
 CREATE SCHEMA auth AUTHORIZATION postgres;GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
 SET ROLE postgres;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
 $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
 CREATE TABLE public.listings(id uuid PRIMARY KEY,status text);
 CREATE TABLE public.orders(id uuid PRIMARY KEY,listing_id uuid REFERENCES public.listings,
 buyer_id uuid,status text,closed_at timestamptz,updated_at timestamptz);
 CREATE TABLE public.order_events(order_id uuid REFERENCES public.orders,actor_id uuid,actor_role text,type text,data jsonb);
 ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
 GRANT SELECT ON public.orders,public.listings,public.order_events TO authenticated;
 CREATE POLICY own_orders ON public.orders FOR SELECT USING(buyer_id=auth.uid());`);
 const original=fs.readFileSync(path.join(root,'tests/fixtures/audited-cancel-order.sql'),'utf8');
 await db.query(original);
 const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const actor=uid(1),other=uid(2),orderId=uid(10),listingId=uid(20);
 // Separate parameterized statements, never interpolate application input.
 await db.query("INSERT INTO public.listings VALUES($1,'reserved')",[listingId]);
 await db.query("INSERT INTO public.orders VALUES($1,$2,$3,'FUNDED',NULL,NULL)",[orderId,listingId,other]);
 const attacker=await connect('authenticated');
 await attacker.query("SELECT set_config('test.actor',$1,false)",[actor]);
 const spoof=async()=>{
  await attacker.query(`CREATE TEMP TABLE orders(LIKE public.orders INCLUDING DEFAULTS) ON COMMIT DROP;
   GRANT ALL ON pg_temp.orders TO postgres;`);
  await attacker.query("INSERT INTO pg_temp.orders VALUES($1,$2,$3,'CREATED',NULL,NULL)",[orderId,listingId,actor]);
 };
 let count=0;
 await attacker.query('BEGIN');await spoof();
 await attacker.query('SELECT public.cancel_order($1)',[orderId]);
 assert.equal((await db.query('SELECT status FROM public.listings WHERE id=$1',[listingId])).rows[0].status,'reserved');
 // Inspect uncommitted exploit from the invoking connection.
 assert.equal((await attacker.query('SELECT status FROM public.listings WHERE id=$1',[listingId])).rows[0].status,'active');
 await attacker.query('ROLLBACK');count++;
 const body=(await db.query("SELECT prosrc FROM pg_proc WHERE oid='public.cancel_order(uuid)'::regprocedure")).rows[0].prosrc;
 const patch=fs.readFileSync(path.join(root,'supabase/security/fix-cancel-order-access.sql'),'utf8');
 const metadata=(await db.query(patch)).at(-1).rows[0];
 assert.deepEqual(metadata,{function_name:'cancel_order',settings:['search_path=pg_catalog, public, pg_temp'],anon:false,authenticated:true,service_role:true});count++;
 await db.query(patch);
 assert.equal((await db.query("SELECT prosrc FROM pg_proc WHERE oid='public.cancel_order(uuid)'::regprocedure")).rows[0].prosrc,body);count++;
 await attacker.query('BEGIN');await spoof();
 await assert.rejects(attacker.query('SELECT public.cancel_order($1)',[orderId]),e=>e.code==='P0001');
 await attacker.query('ROLLBACK');
 assert.equal((await db.query('SELECT status FROM public.listings WHERE id=$1',[listingId])).rows[0].status,'reserved');count++;
 assert.equal((await db.query('SELECT status FROM public.orders WHERE id=$1',[orderId])).rows[0].status,'FUNDED');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM public.order_events')).rows[0].n,0);
 const anon=await connect('anon');await assert.rejects(anon.query('SELECT public.cancel_order($1)',[orderId]),e=>e.code==='42501');count++;
 for(const [buyer,status] of [[actor,'CREATED'],[other,'CREATED'],[actor,'FUNDED'],[actor,'SHIPPED'],[actor,'DELIVERED'],[actor,'COMPLETED'],[actor,'CANCELLED'],[actor,'REFUNDED']]){
  await db.query('UPDATE public.orders SET buyer_id=$1,status=$2 WHERE id=$3',[buyer,status,orderId]);
  await attacker.query('BEGIN');
  if(buyer===actor&&status==='CREATED'){
   await attacker.query('SELECT public.cancel_order($1)',[orderId]);
   assert.equal((await attacker.query('SELECT status FROM public.orders WHERE id=$1',[orderId])).rows[0].status,'CANCELLED');
   assert.equal((await attacker.query('SELECT status FROM public.listings WHERE id=$1',[listingId])).rows[0].status,'active');
   assert.equal((await attacker.query('SELECT count(*)::int AS n FROM public.order_events')).rows[0].n,1);
  }else await assert.rejects(attacker.query('SELECT public.cancel_order($1)',[orderId]),e=>e.code==='P0001');
  await attacker.query('ROLLBACK');count++;
 }
 await db.query("UPDATE public.orders SET buyer_id=$1,status='CREATED' WHERE id=$2",[actor,orderId]);
 await attacker.query("SELECT set_config('test.actor','',false)");
 await assert.rejects(attacker.query('SELECT public.cancel_order($1)',[orderId]),e=>e.code==='P0001');count++;
 await attacker.query("SELECT set_config('test.actor',$1,false)",[actor]);
 await assert.rejects(attacker.query('SELECT public.cancel_order(NULL)'),e=>e.code==='P0001');count++;
 console.log(`PASS: ${count} cancellation access checks, including reproduced temporary-table attack and unchanged installed function body. Synthetic PostgreSQL only.`);
 await db.query(`ALTER TABLE public.orders ADD COLUMN escrow_address text,ADD COLUMN escrow_descriptor text,
  ADD COLUMN shipping_address text,ADD COLUMN funding_txid text,ADD COLUMN funding_vout integer;`);
 const guard=fs.readFileSync(path.join(root,'supabase/security/guard-cancel-payment-details.sql'),'utf8');
 await db.query(guard);await db.query(guard);let guarded=0;
 const snapshot=async()=>JSON.stringify((await db.query(`SELECT
  (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM public.orders o) AS orders,
  (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.listings l) AS listings,
  (SELECT jsonb_agg(to_jsonb(e)) FROM public.order_events e) AS events`)).rows);
 for(const column of ['escrow_address','escrow_descriptor','shipping_address','funding_txid','funding_vout']){
  // Identifiers are from the fixed allowlist above, never application input.
  await db.query(`UPDATE public.orders SET ${column}=$1 WHERE id=$2`,[column==='funding_vout'?0:'synthetic-public-detail',orderId]);
  const before=await snapshot();
  await assert.rejects(attacker.query('SELECT public.cancel_order($1)',[orderId]),e=>e.code==='P0001');
  assert.equal(await snapshot(),before);guarded++;
  await db.query(`UPDATE public.orders SET ${column}=NULL WHERE id=$1`,[orderId]);
 }
 for(const status of ['active','sold','removed',null]){
  await db.query('UPDATE public.listings SET status=$1 WHERE id=$2',[status,listingId]);const before=await snapshot();
  await assert.rejects(attacker.query('SELECT public.cancel_order($1)',[orderId]),e=>e.code==='P0001');
  assert.equal(await snapshot(),before);guarded++;
 }
 await db.query("UPDATE public.listings SET status='reserved' WHERE id=$1",[listingId]);
 for(const status of ['CREATED','FUNDED','COMPLETED',null,'CANCELLED','REFUNDED']){
  const extra=uid(30);await db.query('INSERT INTO public.orders(id,listing_id,buyer_id,status) VALUES($1,$2,$3,$4)',[extra,listingId,other,status]);
  const before=await snapshot();await attacker.query('BEGIN');
  if(['CANCELLED','REFUNDED'].includes(status))await attacker.query('SELECT public.cancel_order($1)',[orderId]);
  else await assert.rejects(attacker.query('SELECT public.cancel_order($1)',[orderId]),e=>e.code==='P0001');
  await attacker.query('ROLLBACK');assert.equal(await snapshot(),before);guarded++;
  await db.query('DELETE FROM public.orders WHERE id=$1',[extra]);
 }
 await attacker.query('BEGIN');await attacker.query('SELECT public.cancel_order($1)',[orderId]);
 assert.equal((await attacker.query('SELECT status FROM public.orders WHERE id=$1',[orderId])).rows[0].status,'CANCELLED');
 await attacker.query('ROLLBACK');guarded++;
 const writer=await connect();await writer.query('BEGIN');
 await writer.query('SELECT id FROM public.orders WHERE id=$1 FOR UPDATE',[orderId]);
 await writer.query("UPDATE public.orders SET escrow_address='synthetic-late-address' WHERE id=$1",[orderId]);
 let completed=false;
 const cancellation=attacker.query('SELECT public.cancel_order($1)',[orderId]).then(()=>{throw Error('Cancellation should reject prepared payment')},e=>{assert.equal(e.code,'P0001');completed=true});
 // Observe the actual row-lock wait rather than relying on a timed sleep.
 const until=Date.now()+5000;let waiting=false;
 while(Date.now()<until){
  const blockers=(await db.query('SELECT pg_blocking_pids($1) AS ids',[attacker.processID])).rows[0].ids;
  if(blockers.includes(writer.processID)){waiting=true;break;}
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 assert.equal(waiting,true);assert.equal(completed,false);await writer.query('COMMIT');await cancellation;
 assert.equal((await db.query('SELECT status FROM public.orders WHERE id=$1',[orderId])).rows[0].status,'CREATED');
 assert.equal((await db.query('SELECT status FROM public.listings WHERE id=$1',[listingId])).rows[0].status,'reserved');guarded++;
 for(const [buyer,status] of [[actor,'FUNDED'],[other,'CREATED'],[actor,'REFUNDED']]){
  await db.query('UPDATE public.orders SET buyer_id=$1,status=$2,escrow_address=NULL WHERE id=$3',[buyer,status,orderId]);
  const before=await snapshot();
  await assert.rejects(attacker.query('SELECT public.cancel_order($1)',[orderId]),e=>e.code==='P0001');
  assert.equal(await snapshot(),before);guarded++;
 }
 await assert.rejects(anon.query('SELECT public.cancel_order($1)',[orderId]),e=>e.code==='42501');guarded++;
 console.log(`PASS: ${guarded} payment-details cancellation guards, including real concurrent row-lock wait. No Bitcoin operations.`);
}
