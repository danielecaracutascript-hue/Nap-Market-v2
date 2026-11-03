import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function runShippingTests(db,root){
 await db.query(`CREATE ROLE postgres NOSUPERUSER NOBYPASSRLS;
 CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 GRANT USAGE,CREATE ON SCHEMA public TO postgres;
 GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
 CREATE SCHEMA auth AUTHORIZATION postgres;SET ROLE postgres;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
 $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
 CREATE TABLE orders(id uuid PRIMARY KEY,buyer_id uuid,seller_id uuid,status text,
 carrier text,tracking_number text,shipped_at timestamptz,updated_at timestamptz,
 return_tracking_number text,return_deadline timestamptz);
 CREATE TABLE order_events(order_id uuid,actor_id uuid,actor_role text,type text,data jsonb);`);
 const untouched=['confirm_receipt','request_return','confirm_return_received'];
 for(const name of untouched)await db.query(`CREATE FUNCTION public.${name}(uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN RAISE EXCEPTION 'Must not execute fixture'; END $$;
 REVOKE ALL ON FUNCTION public.${name}(uuid) FROM PUBLIC,anon;
 GRANT EXECUTE ON FUNCTION public.${name}(uuid) TO authenticated,service_role`);
 const before=(await db.query('SELECT proname,prosrc,proacl FROM pg_proc WHERE proname=ANY($1) ORDER BY proname',[untouched])).rows;
 const script=fs.readFileSync(path.join(root,'supabase/security/fix-shipping-inputs.sql'),'utf8');
 const installed=(await db.query(script)).at(-1).rows;
 assert.equal(installed.length,5);
 for(const row of installed){assert.equal(row.anon,false);assert.equal(row.authenticated,true);assert.equal(row.service_role,true);assert.deepEqual(row.settings,['search_path=pg_catalog, public, pg_temp'])}
 const after=(await db.query('SELECT proname,prosrc,proacl FROM pg_proc WHERE proname=ANY($1) ORDER BY proname',[untouched])).rows;
 assert.deepEqual(after,before);await db.query(script);let count=3;
 const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const [id,buyer,seller,other]=[1,2,3,4].map(uid);
 await db.query("INSERT INTO orders(id,buyer_id,seller_id,status,return_deadline) VALUES($1,$2,$3,'FUNDED',now()+interval '1 day')",[id,buyer,seller]);
 const state=async()=> (await db.query(`SELECT jsonb_build_object('orders',(SELECT jsonb_agg(o) FROM orders o),
 'events',(SELECT jsonb_agg(e) FROM order_events e)) AS value`)).rows[0].value;
 const actor=who=>db.query("SELECT set_config('test.actor',$1,false)",[who]);
 const ship=(carrier='Carrier',tracking='TRACK123')=>db.query('SELECT public.mark_shipped($1,$2,$3)',[id,carrier,tracking]);
 const returned=(tracking='RETURN123')=>db.query('SELECT public.ship_return($1,$2)',[id,tracking]);
 const test=async(name,fn)=>{await db.query('BEGIN');try{await fn();count++;console.log('PASS: '+name)}finally{await db.query('ROLLBACK')}};
 const reject=async(fn,code='P0001')=>{
  const initial=await state();await db.query('SAVEPOINT invalid');await assert.rejects(fn,e=>e.code===code);
  await db.query('ROLLBACK TO SAVEPOINT invalid');assert.deepEqual(await state(),initial);
 };
 for(const [carrier,tracking] of [[null,'TRACK123'],['Carrier',null],[' ','TRACK123'],['C','TRACK123'],['Carrier','    '],['Carrier','1234']]){
  await test('invalid outbound shipment input has no side effects',async()=>{await actor(seller);await reject(()=>ship(carrier,tracking))});
 }
 for(const tracking of [null,'    ','1234']){
  await test('invalid return tracking has no side effects',async()=>{
   await actor(buyer);await db.query("UPDATE orders SET status='RETURN_REQUESTED'");await reject(()=>returned(tracking));
  });
 }
 for(const mode of ['ship','return']){
  for(const who of ['',other,mode==='ship'?buyer:seller]){
   await test('wrong participant cannot change shipment state',async()=>{
    await actor(who);if(mode==='return')await db.query("UPDATE orders SET status='RETURN_REQUESTED'");
    await reject(()=>mode==='ship'?ship():returned());
   });
  }
  await test('wrong order status is rejected',async()=>{
   await actor(mode==='ship'?seller:buyer);await db.query("UPDATE orders SET status='CREATED'");await reject(()=>mode==='ship'?ship():returned());
  });
  await test('valid shipment normalized with exactly one event',async()=>{
   await actor(mode==='ship'?seller:buyer);
   if(mode==='return')await db.query("UPDATE orders SET status='RETURN_REQUESTED'");
   await db.query('SET LOCAL ROLE authenticated');
   await (mode==='ship'?ship('  Carrier  ','  TRACK123  '):returned('  RETURN123  '));
   await db.query('SET LOCAL ROLE postgres');const result=await state();
   assert.equal(result.orders[0].status,mode==='ship'?'SHIPPED':'RETURN_SHIPPED');
   assert.equal(result.orders[0][mode==='ship'?'tracking_number':'return_tracking_number'],mode==='ship'?'TRACK123':'RETURN123');
   assert.equal(result.events.length,1);assert.equal(result.events[0].actor_id,mode==='ship'?seller:buyer);
   await reject(()=>mode==='ship'?ship():returned());
  });
  await test('event failure rolls back shipment state',async()=>{
   await actor(mode==='ship'?seller:buyer);if(mode==='return')await db.query("UPDATE orders SET status='RETURN_REQUESTED'");
   await db.query(`CREATE FUNCTION fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
   CREATE TRIGGER fail_event BEFORE INSERT ON order_events FOR EACH ROW EXECUTE FUNCTION fail_event()`);
   await reject(()=>mode==='ship'?ship():returned());
  });
 }
 for(const deadline of [null,'2000-01-01']){
  await test('missing or expired return deadline rejected',async()=>{
   await actor(buyer);await db.query("UPDATE orders SET status='RETURN_REQUESTED',return_deadline=$1",[deadline]);await reject(()=>returned());
  });
 }
 for(const fn of [ship,returned]){
  await test('anonymous execution denied',async()=>{
   await db.query('SET LOCAL ROLE anon');await db.query('SAVEPOINT denied');
   await assert.rejects(()=>fn(),e=>e.code==='42501');await db.query('ROLLBACK TO SAVEPOINT denied');
  });
 }
 console.log(`PASS: ${count} focused PostgreSQL shipping checks. Synthetic orders only; no Bitcoin or remote database calls.`);
}
