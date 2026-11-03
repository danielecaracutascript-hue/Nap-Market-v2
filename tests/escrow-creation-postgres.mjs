import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function runEscrowCreationTests(db,root,connect){
 await db.query(`
 CREATE ROLE postgres NOSUPERUSER NOBYPASSRLS;
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 GRANT USAGE,CREATE ON SCHEMA public TO postgres;
 GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
 SET ROLE postgres;
 CREATE TABLE orders(id uuid PRIMARY KEY,buyer_id uuid,seller_id uuid,status text,
 escrow_index integer,expires_at timestamptz,escrow_descriptor text,escrow_address text,
 shipping_address text,funding_txid text,funding_vout integer,updated_at timestamptz);
 CREATE TABLE order_events(order_id uuid,actor_role text,type text,data jsonb);
 -- Exact business behavior supplied in the audit, on synthetic tables only.
 CREATE FUNCTION set_order_escrow(p_order uuid,p_descriptor text,p_address text,p_shipping_address text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN
 UPDATE orders SET escrow_descriptor=p_descriptor,escrow_address=p_address,
 shipping_address=p_shipping_address,updated_at=now()
 WHERE id=p_order AND status='CREATED' AND escrow_address IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Escrow already set, or order not payable'; END IF;
 INSERT INTO order_events VALUES(p_order,'platform','escrow_created',jsonb_build_object('address',p_address));
 END $$;
 `);
 const script=fs.readFileSync(path.join(root,'supabase/security/add-escrow-creation-snapshot.sql'),'utf8');
 const acl={anon:false,authenticated:false,service_role:true};
 assert.deepEqual((await db.query(script)).at(-1).rows[0],acl);
 assert.deepEqual((await db.query(script)).at(-1).rows[0],acl);let count=2;
 const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const [id,buyer,seller]=[1,2,3].map(uid);
 await db.query("INSERT INTO orders(id,buyer_id,seller_id,status,escrow_index,expires_at) VALUES($1,$2,$3,'CREATED',42,now()+interval '1 day')",[id,buyer,seller]);
 const expected=(await db.query(`SELECT jsonb_build_object('buyer_id',buyer_id::text,'seller_id',seller_id::text,
 'escrow_index',escrow_index::text,'expires_at',expires_at) AS value FROM orders`)).rows[0].value;
 const call=(client=db,overrides={})=>{
  const args={actor:buyer,descriptor:'synthetic-policy',address:'synthetic-escrow',shipping:'synthetic-shipping',expected,...overrides};
  return client.query('SELECT public.set_order_escrow_snapshot($1,$2,$3,$4,$5,$6::jsonb) AS value',
   [id,args.actor,args.descriptor,args.address,args.shipping,args.expected]);
 };
 const snapshot=async()=> (await db.query(`SELECT jsonb_build_object('orders',(SELECT jsonb_agg(o) FROM orders o),
 'events',(SELECT jsonb_agg(e) FROM order_events e)) AS value`)).rows[0].value;
 const test=async(name,fn)=>{await db.query('BEGIN');try{await fn();count++;console.log('PASS: '+name)}finally{await db.query('ROLLBACK')}};
 const reject=async(args={})=>{
  const before=await snapshot();await db.query('SAVEPOINT invalid');
  await assert.rejects(()=>call(db,args),e=>e.code==='P0001');
  await db.query('ROLLBACK TO SAVEPOINT invalid');assert.deepEqual(await snapshot(),before);
 };
 for(const args of [{actor:null},{actor:seller},{expected:null},{descriptor:''},{address:null},{shipping:' '}]){
  await test('invalid input leaves order unchanged',()=>reject(args));
 }
 for(const key of Object.keys(expected)){
  await test('stale creation snapshot rejected: '+key,()=>reject({expected:{...expected,[key]:null}}));
 }
 for(const status of ['FUNDED','CANCELLED']){
  await test('preserve existing nonpayable order',async()=>{await db.query('UPDATE orders SET status=$1',[status]);await reject()});
 }
 for(const field of ['escrow_descriptor','shipping_address','funding_txid']){
  await test('preserve incomplete preexisting metadata',async()=>{await db.query(`UPDATE orders SET ${field}='existing-data'`);await reject()});
 }
 await test('expiry checked with database clock',async()=>{
  await db.query("UPDATE orders SET expires_at=clock_timestamp()-interval '1 second'");
  const expires=(await db.query('SELECT expires_at::text AS value FROM orders')).rows[0].value;
  await reject({expected:{...expected,expires_at:expires}});
 });
 await test('new escrow and different repeated candidates produce one stored address/event',async()=>{
  await db.query('SET LOCAL ROLE service_role');assert.deepEqual((await call()).rows[0].value,{ok:true,alreadyCreated:false});
  assert.deepEqual((await call(db,{address:'different-candidate'})).rows[0].value,{ok:true,alreadyCreated:true});
  await db.query('SET LOCAL ROLE postgres');const state=await snapshot();
  assert.equal(state.orders[0].escrow_address,'synthetic-escrow');assert.equal(state.events.length,1);
 });
 for(const role of ['anon','authenticated']){
  await test('client execution denied',async()=>{
   await db.query(`SET LOCAL ROLE ${role}`);await db.query('SAVEPOINT denied');
   await assert.rejects(()=>call(),e=>e.code==='42501');await db.query('ROLLBACK TO SAVEPOINT denied');
  });
 }
 await test('legacy event failure rolls back all stored details',async()=>{
  await db.query(`CREATE FUNCTION fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
  CREATE TRIGGER fail_event BEFORE INSERT ON order_events FOR EACH ROW EXECUTE FUNCTION fail_event()`);await reject();
 });
 // Actual two-connection race: only the winner's addresses and event survive.
 const competitor=await connect();
 const pid=(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const competitorPid=(await competitor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 await competitor.query('BEGIN');assert.equal((await call(competitor)).rows[0].value.alreadyCreated,false);
 const pending=call(db,{address:'losing-candidate',shipping:'losing-shipping'}).then(value=>({value}),error=>({error}));
 let blocked=false;
 for(let attempt=0;attempt<100;attempt++){
  const blockers=(await competitor.query('SELECT pg_blocking_pids($1) AS blockers',[pid])).rows[0].blockers;
  if(blockers.includes(competitorPid)){blocked=true;break}
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 await competitor.query('COMMIT');const second=await pending;
 assert.equal(blocked,true);if(second.error)throw second.error;
 assert.deepEqual(second.value.rows[0].value,{ok:true,alreadyCreated:true});
 const state=await snapshot();assert.equal(state.orders[0].escrow_address,'synthetic-escrow');
 assert.equal(state.orders[0].shipping_address,'synthetic-shipping');assert.equal(state.events.length,1);
 await competitor.end();count++;
 console.log(`PASS: ${count} PostgreSQL escrow-creation checks, including two concurrent connections. No Bitcoin or remote database calls.`);
}
