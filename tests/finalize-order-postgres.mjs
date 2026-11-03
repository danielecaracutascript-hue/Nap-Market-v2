import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function runFinalizeOrderTests(db,root,connect){
 await db.query(`CREATE ROLE postgres LOGIN NOSUPERUSER NOBYPASSRLS;
 CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 GRANT pg_read_all_settings TO postgres;
 GRANT anon,authenticated,service_role TO postgres WITH INHERIT FALSE;
 GRANT USAGE,CREATE ON SCHEMA public TO postgres;
 GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
 CREATE SCHEMA auth AUTHORIZATION postgres;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
 SET ROLE postgres;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
 $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
 CREATE TABLE public.listings(id uuid PRIMARY KEY,status text);
 CREATE TABLE public.orders(id uuid PRIMARY KEY,listing_id uuid REFERENCES public.listings,
 buyer_id uuid,seller_id uuid,status text,window_ends_at timestamptz,return_deadline timestamptz,
 closed_at timestamptz,updated_at timestamptz);
 CREATE TABLE public.order_events(order_id uuid REFERENCES public.orders,actor_id uuid,actor_role text,type text,data jsonb);
 ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
 GRANT SELECT ON public.orders,public.listings,public.order_events TO authenticated;
 CREATE POLICY participant_orders ON public.orders FOR SELECT USING(buyer_id=auth.uid() OR seller_id=auth.uid());`);
 await db.query(fs.readFileSync(path.join(root,'tests/fixtures/audited-finalize-order.sql'),'utf8'));
 const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const buyer=uid(1),seller=uid(2),stranger=uid(3),id=uid(10),listing=uid(20);
 await db.query("INSERT INTO public.listings VALUES($1,'reserved')",[listing]);
 await db.query("INSERT INTO public.orders VALUES($1,$2,$3,$4,'FUNDED',NULL,NULL,NULL,NULL)",[id,listing,buyer,seller]);
 const caller=await connect('authenticated');
 await caller.query("SELECT set_config('test.actor',$1,false)",[stranger]);
 const spoof=async()=>{
  await caller.query(`CREATE TEMP TABLE orders(LIKE public.orders INCLUDING DEFAULTS) ON COMMIT DROP;
   GRANT ALL ON pg_temp.orders TO postgres;`);
  await caller.query("INSERT INTO pg_temp.orders VALUES($1,$2,$3,$3,'DELIVERED',now()-interval '1 day',NULL,NULL,NULL)",[id,listing,stranger]);
 };
 await caller.query('BEGIN');await spoof();
 assert.equal((await caller.query('SELECT public.finalize_order($1) AS result',[id])).rows[0].result,true);
 assert.equal((await caller.query('SELECT status FROM public.listings WHERE id=$1',[listing])).rows[0].status,'sold');
 await caller.query('ROLLBACK');let checks=1;
 const body=(await db.query("SELECT prosrc FROM pg_proc WHERE oid='public.finalize_order(uuid)'::regprocedure")).rows[0].prosrc;
 const patch=fs.readFileSync(path.join(root,'supabase/security/fix-finalize-order-access.sql'),'utf8');
 assert.deepEqual((await db.query(patch)).at(-1).rows[0],{function_name:'finalize_order',settings:['search_path=pg_catalog, public, pg_temp'],anon:false,authenticated:true,service_role:true});checks++;
 await db.query(patch);
 assert.equal((await db.query("SELECT prosrc FROM pg_proc WHERE oid='public.finalize_order(uuid)'::regprocedure")).rows[0].prosrc,body);checks++;
 await caller.query('BEGIN');await spoof();
 assert.equal((await caller.query('SELECT public.finalize_order($1) AS result',[id])).rows[0].result,false);
 await caller.query('ROLLBACK');
 assert.equal((await db.query('SELECT status FROM public.orders WHERE id=$1',[id])).rows[0].status,'FUNDED');
 assert.equal((await db.query('SELECT status FROM public.listings WHERE id=$1',[listing])).rows[0].status,'reserved');checks++;
 const anon=await connect('anon');await assert.rejects(anon.query('SELECT public.finalize_order($1)',[id]),e=>e.code==='42501');checks++;
 const snapshot=async()=>JSON.stringify((await db.query(`SELECT
  (SELECT jsonb_agg(to_jsonb(o)) FROM public.orders o) AS orders,
  (SELECT jsonb_agg(to_jsonb(l)) FROM public.listings l) AS listings,
  (SELECT jsonb_agg(to_jsonb(e)) FROM public.order_events e) AS events`)).rows);
 for(const [status,deadline,actor] of [
  ['CREATED','past',buyer],['FUNDED','past',buyer],['SHIPPED','past',buyer],['DISPUTED','past',buyer],
  ['CANCELLED','past',buyer],['REFUNDED','past',buyer],['DELIVERED','future',buyer],
  ['RETURN_REQUESTED','future',seller],['DELIVERED','null',buyer],['RETURN_REQUESTED','null',buyer],
  ['DELIVERED','past',stranger],['DELIVERED','past',''],
 ]){
  const timestamp=deadline==='null'?null:new Date(Date.now()+(deadline==='past'?-86400000:86400000)).toISOString();
  await db.query('UPDATE public.orders SET status=$1,window_ends_at=$2,return_deadline=$2 WHERE id=$3',[status,timestamp,id]);
  await caller.query("SELECT set_config('test.actor',$1,false)",[actor]);const before=await snapshot();
  assert.equal((await caller.query('SELECT public.finalize_order($1) AS result',[id])).rows[0].result,false);
  assert.equal(await snapshot(),before);checks++;
 }
 for(const status of ['DELIVERED','RETURN_REQUESTED'])for(const actor of [buyer,seller]){
  await db.query("UPDATE public.orders SET status=$1,window_ends_at=now()-interval '1 day',return_deadline=now()-interval '1 day' WHERE id=$2",[status,id]);
  await caller.query("SELECT set_config('test.actor',$1,false)",[actor]);await caller.query('BEGIN');
  assert.equal((await caller.query('SELECT public.finalize_order($1) AS result',[id])).rows[0].result,true);
  const order=(await caller.query('SELECT * FROM public.orders WHERE id=$1',[id])).rows[0];
  assert.equal(order.status,'COMPLETED');assert.ok(order.closed_at&&order.updated_at);
  assert.equal((await caller.query('SELECT status FROM public.listings WHERE id=$1',[listing])).rows[0].status,'sold');
  const events=(await caller.query('SELECT * FROM public.order_events')).rows;
  assert.equal(events.length,1);assert.equal(events[0].actor_id,actor);assert.equal(events[0].type,'auto_completed');
  assert.equal(events[0].data.reason,status==='DELIVERED'?'window_expired':'return_not_shipped');
  assert.equal((await caller.query('SELECT public.finalize_order($1) AS result',[id])).rows[0].result,false);
  assert.equal((await caller.query('SELECT count(*)::int AS n FROM public.order_events')).rows[0].n,1);
  await caller.query('ROLLBACK');checks++;
 }
 console.log(`PASS: ${checks} commercial-completion checks, temporary-table attack reproduced then blocked, installed body preserved. No Bitcoin modules or operations.`);
}
