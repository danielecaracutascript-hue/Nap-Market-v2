import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function setupFundingSnapshotFixture(db,root){
 await db.query(`
 CREATE ROLE postgres NOSUPERUSER NOBYPASSRLS;
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 GRANT USAGE,CREATE ON SCHEMA public TO postgres;
 GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
 SET ROLE postgres;
 CREATE TABLE orders(id uuid PRIMARY KEY,buyer_id uuid,seller_id uuid,status text,
 price_sats bigint,buyer_commission_sats bigint,shipping_sats bigint,
 escrow_descriptor text,escrow_index integer,escrow_address text,shipping_address text,
 expires_at timestamptz,funding_txid text,funding_vout integer,funding_height integer,
 funded_at timestamptz,updated_at timestamptz);
 CREATE TABLE order_events(order_id uuid,actor_role text,type text,data jsonb);
 -- Reviewed active legacy behavior on a synthetic schema, not a remote call.
 CREATE FUNCTION mark_order_funded(p_order uuid,p_txid text,p_vout integer,p_height integer)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
 BEGIN
 UPDATE orders SET status='FUNDED',funded_at=now(),funding_txid=p_txid,
 funding_vout=p_vout,funding_height=p_height,updated_at=now()
 WHERE id=p_order AND status='CREATED';
 IF NOT FOUND THEN RAISE EXCEPTION 'Order is not waiting for payment'; END IF;
 INSERT INTO order_events VALUES(p_order,'platform','payment_confirmed',
 jsonb_build_object('txid',p_txid,'vout',p_vout,'height',p_height));
 END $$;
 `);
 const script=fs.readFileSync(path.join(root,'supabase/security/add-funding-snapshot.sql'),'utf8');
 assert.deepEqual((await db.query(script)).at(-1).rows[0],{anon:false,authenticated:false,service_role:true});
 await db.query(script);
 const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const [id,buyer,seller,other]=[1,2,3,4].map(uid),txid='a'.repeat(64);
 await db.query(`INSERT INTO orders(id,buyer_id,seller_id,status,price_sats,buyer_commission_sats,
 shipping_sats,escrow_descriptor,escrow_index,escrow_address,shipping_address,expires_at)
 VALUES($1,$2,$3,'CREATED',100000,4000,1000,'synthetic-public-policy',42,'escrow-address','shipping-address',now()+interval '1 day')`,[id,buyer,seller]);
 const expected=(await db.query(`SELECT jsonb_build_object(
 'buyer_id',buyer_id::text,'seller_id',seller_id::text,'price_sats',price_sats::text,
 'buyer_commission_sats',buyer_commission_sats::text,'shipping_sats',shipping_sats::text,
 'escrow_descriptor',escrow_descriptor,'escrow_index',escrow_index::text,
 'escrow_address',escrow_address,'shipping_address',shipping_address,'expires_at',expires_at) AS value FROM orders`)).rows[0].value;
 return {id,buyer,seller,other,txid,expected};
}

export async function runFundingSnapshotTests(db,root,connect){
 const {id,buyer,seller,other,txid,expected}=await setupFundingSnapshotFixture(db,root);
 const snapshot=async()=> (await db.query(`SELECT jsonb_build_object(
 'orders',(SELECT jsonb_agg(o) FROM orders o),'events',(SELECT jsonb_agg(e) FROM order_events e)) AS value`)).rows[0].value;
 const call=(overrides={})=>{
  const args={actor:buyer,txid,vout:2,height:100,escrow:104000,shipping:1000,expected,...overrides};
  return db.query('SELECT public.confirm_order_funding_snapshot($1,$2,$3,$4,$5,$6,$7,$8::jsonb) AS value',
   [id,args.actor,args.txid,args.vout,args.height,args.escrow,args.shipping,args.expected]);
 };
 let count=2;
 const test=async(name,fn)=>{await db.query('BEGIN');try{await fn();count++;console.log('PASS: '+name)}finally{await db.query('ROLLBACK')}};
 const rejected=async(args)=>{
  const before=await snapshot();await db.query('SAVEPOINT invalid');
  await assert.rejects(()=>call(args),e=>e.code==='P0001');
  await db.query('ROLLBACK TO SAVEPOINT invalid');assert.deepEqual(await snapshot(),before);
 };
 for(const args of [{actor:null},{actor:other},{txid:'bad'},{vout:-1},{height:-1},
  {escrow:104001},{escrow:null},{shipping:999},{shipping:null},{expected:null}]){
  await test('invalid verified input cannot modify order',()=>rejected(args));
 }
 for(const key of Object.keys(expected)){
  await test('stale snapshot rejected: '+key,()=>rejected({expected:{...expected,[key]:null}}));
 }
 for(const status of ['CANCELLED','FUNDED','SHIPPED']){
  await test('existing nonpayable order preserved',async()=>{
   await db.query('UPDATE orders SET status=$1',[status]);await rejected({});
  });
 }
 await test('database clock rejects expiry independently of server',async()=>{
  await db.query("UPDATE orders SET expires_at=clock_timestamp()-interval '1 second'");
  const expired=(await db.query('SELECT expires_at FROM orders')).rows[0].expires_at.toISOString();
  await rejected({expected:{...expected,expires_at:expired}});
 });
 await test('existing funding marker cannot be overwritten',async()=>{
  await db.query('UPDATE orders SET funding_txid=$1,funding_vout=0',['b'.repeat(64)]);await rejected({});
 });
 for(const actor of [buyer,seller]){
  await test('valid verified funding and duplicate produce exactly one event',async()=>{
   await db.query('SET LOCAL ROLE service_role');
   assert.deepEqual((await call({actor})).rows[0].value,{ok:true,alreadyFunded:false});
   assert.deepEqual((await call({actor})).rows[0].value,{ok:true,alreadyFunded:true});
   await db.query('SET LOCAL ROLE postgres');const state=await snapshot();
   assert.equal(state.orders[0].status,'FUNDED');assert.equal(state.orders[0].funding_txid,txid);
   assert.equal(state.events.length,1);
   await rejected({txid:'b'.repeat(64)});
  });
 }
 for(const role of ['anon','authenticated']){
  await test('client execution denied',async()=>{
   await db.query(`SET LOCAL ROLE ${role}`);await db.query('SAVEPOINT denied');
   await assert.rejects(()=>call(),e=>e.code==='42501');await db.query('ROLLBACK TO SAVEPOINT denied');
  });
 }
 await test('legacy failure rolls back wrapper and event',async()=>{
  await db.query(`CREATE FUNCTION fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
   CREATE TRIGGER fail_event BEFORE INSERT ON order_events FOR EACH ROW EXECUTE FUNCTION fail_event()`);
  await rejected({});
 });
 // A real competing connection changes the order while the funding call waits.
 const competitor=await connect();
 const pid=(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const competingPid=(await competitor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 await competitor.query('BEGIN');
 await competitor.query('UPDATE orders SET price_sats=price_sats+1 WHERE id=$1',[id]);
 const pending=call().then(value=>({value}),error=>({error}));
 let blocked=false;
 for(let attempt=0;attempt<100;attempt++){
  const locks=(await competitor.query('SELECT pg_blocking_pids($1) AS blockers',[pid])).rows[0].blockers;
  if(locks.includes(competingPid)){blocked=true;break}
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 await competitor.query('COMMIT');
 const result=await pending;
 assert.equal(blocked,true,'funding must wait on the competing order lock');
 assert.equal(result.error?.code,'P0001');
 const afterRace=await snapshot();
 assert.equal(afterRace.orders[0].status,'CREATED');assert.equal(afterRace.orders[0].price_sats,100001);
 assert.equal(afterRace.orders[0].funding_txid,null);assert.equal(afterRace.events,null);
 await competitor.end();count++;
 console.log(`PASS: ${count} focused funding PostgreSQL checks, including real concurrent snapshot change. No Bitcoin or remote database calls.`);
}
