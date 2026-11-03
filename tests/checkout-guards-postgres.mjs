import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function runCheckoutGuardTests(db,root,connect){
 await db.query(`CREATE ROLE postgres NOSUPERUSER NOBYPASSRLS;
 CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 GRANT USAGE,CREATE ON SCHEMA public TO postgres;
 GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
 CREATE SCHEMA auth AUTHORIZATION postgres;GRANT USAGE ON SCHEMA auth TO anon,authenticated;
 SET ROLE postgres;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
 $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
 CREATE TABLE profiles(id uuid PRIMARY KEY);
 CREATE TABLE listings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),seller_id uuid NOT NULL REFERENCES profiles,
 status text NOT NULL,title text DEFAULT 'Synthetic listing');
 CREATE TABLE orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),listing_id uuid REFERENCES listings,
 buyer_id uuid REFERENCES profiles,seller_id uuid REFERENCES profiles,status text NOT NULL);
 CREATE TABLE addresses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES profiles,
 country char(2) NOT NULL,encrypted_payload bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE listings ENABLE ROW LEVEL SECURITY;ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
 ALTER TABLE addresses ENABLE ROW LEVEL SECURITY;
 GRANT SELECT,INSERT,UPDATE,DELETE ON listings TO anon,authenticated;
 GRANT SELECT ON orders TO anon,authenticated;
 GRANT ALL ON addresses TO anon,authenticated,service_role;
 CREATE POLICY "active listings readable" ON listings FOR SELECT USING(status='active' OR seller_id=auth.uid());
 CREATE POLICY "seller updates listings" ON listings FOR UPDATE USING(seller_id=auth.uid());
 CREATE POLICY "participants read orders" ON orders FOR SELECT USING(buyer_id=auth.uid() OR seller_id=auth.uid());
 CREATE POLICY "own addresses" ON addresses FOR ALL USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
 CREATE FUNCTION my_addresses() RETURNS TABLE(id uuid,country character,full_text text)
 LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT a.id,a.country,convert_from(a.encrypted_payload,'UTF8') FROM addresses a
 WHERE a.user_id=auth.uid() ORDER BY a.created_at DESC $$;
 REVOKE ALL ON FUNCTION my_addresses() FROM PUBLIC,anon;
 GRANT EXECUTE ON FUNCTION my_addresses() TO authenticated,service_role;
 -- Test double for the audited listing lock/reserve sequence, not full checkout.
 CREATE FUNCTION fixture_reserve(p_listing uuid,p_buyer uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
 DECLARE l listings%ROWTYPE;v_id uuid;BEGIN
 SELECT * INTO l FROM listings WHERE id=p_listing AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Listing unavailable'; END IF;
 INSERT INTO orders(listing_id,buyer_id,seller_id,status) VALUES(l.id,p_buyer,l.seller_id,'CREATED') RETURNING id INTO v_id;
 UPDATE listings SET status='reserved' WHERE id=l.id;RETURN v_id;END $$;`);
 const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const [seller,buyer,other]=[1,2,3].map(uid);
 await db.query('INSERT INTO profiles VALUES($1),($2),($3)',[seller,buyer,other]);
 const actor=who=>db.query("SELECT set_config('test.actor',$1,false)",[who]);
 const listing=async(status='active')=>(await db.query('INSERT INTO listings(seller_id,status) VALUES($1,$2) RETURNING id',[seller,status])).rows[0].id;
 const state=async(id)=>(await db.query('SELECT row_to_json(l) AS value FROM listings l WHERE id=$1',[id])).rows[0].value;
 const reserved=await listing('reserved');
 await actor(seller);await db.query('BEGIN');await db.query('SET LOCAL ROLE authenticated');
 assert.equal((await db.query("UPDATE listings SET status='active' WHERE id=$1",[reserved])).rowCount,1);
 await db.query('ROLLBACK');let count=1;
 const listingPatch=fs.readFileSync(path.join(root,'supabase/security/protect-reserved-listings.sql'),'utf8');
 await db.query(listingPatch);await db.query(listingPatch);count+=2;
 const addressPatch=fs.readFileSync(path.join(root,'supabase/security/fix-address-access.sql'),'utf8');
 const installed=(await db.query(addressPatch)).at(-1).rows;
 for(const row of installed){assert.equal(row.anon,false);assert.equal(row.authenticated,true);assert.equal(row.anon_truncate,false);assert.equal(row.authenticated_truncate,false);assert.equal(row.service_role_truncate,true)}
 await db.query(addressPatch);count+=2;
 const test=async(name,fn)=>{await db.query('BEGIN');try{await fn();count++;console.log('PASS: '+name)}finally{await db.query('ROLLBACK')}};
 for(const status of ['reserved','sold']){
  const id=await listing(status),before=await state(id);
  await test('seller cannot reopen or edit reserved/sold listing',async()=>{
   await actor(seller);await db.query('SET LOCAL ROLE authenticated');
   assert.equal((await db.query("UPDATE listings SET status='active',title='Changed' WHERE id=$1",[id])).rowCount,0);
   await db.query('SET LOCAL ROLE postgres');assert.deepEqual(await state(id),before);
  });
 }
 const active=await listing();
 await test('seller cannot forge a reserved/sold status',async()=>{
  await actor(seller);await db.query('SET LOCAL ROLE authenticated');await db.query('SAVEPOINT invalid');
  await assert.rejects(()=>db.query("UPDATE listings SET status='sold' WHERE id=$1",[active]),e=>e.code==='42501');
  await db.query('ROLLBACK TO SAVEPOINT invalid');
 });
 await test('unrelated user cannot edit listing',async()=>{
  await actor(other);await db.query('SET LOCAL ROLE authenticated');
  assert.equal((await db.query("UPDATE listings SET title='Changed' WHERE id=$1",[active])).rowCount,0);
 });
 await test('seller can edit an available unreserved listing',async()=>{
  await actor(seller);await db.query('SET LOCAL ROLE authenticated');
  assert.equal((await db.query("UPDATE listings SET title='Updated title' WHERE id=$1",[active])).rowCount,1);
 });
 for(const status of ['CREATED','FUNDED','COMPLETED','CANCELLED','REFUNDED']){
  const id=await listing();await db.query('INSERT INTO orders(listing_id,buyer_id,seller_id,status) VALUES($1,$2,$3,$4)',[id,buyer,seller,status]);
  await test('listing edit follows current linked order status: '+status,async()=>{
   await actor(seller);await db.query('SET LOCAL ROLE authenticated');
   assert.equal((await db.query("UPDATE listings SET title='Edited' WHERE id=$1",[id])).rowCount,['CANCELLED','REFUNDED'].includes(status)?1:0);
  });
 }
 for(const [country,text] of [[null,'Synthetic address'],['IT',null],['11','Synthetic address'],['ITA','Synthetic address'],['IT','    ']]){
  await test('invalid address input leaves no row',async()=>{
   await actor(buyer);await db.query('SET LOCAL ROLE authenticated');await db.query('SAVEPOINT invalid');
   await assert.rejects(()=>db.query('SELECT save_address($1,$2)',[country,text]),e=>e.code==='P0001');
   await db.query('ROLLBACK TO SAVEPOINT invalid');assert.equal((await db.query('SELECT * FROM addresses')).rowCount,0);
  });
 }
 await test('address normalization and isolation remain intact',async()=>{
  await actor(buyer);await db.query('SET LOCAL ROLE authenticated');
  await db.query("SELECT save_address(' it ','  Synthetic address  ')");
  assert.deepEqual((await db.query('SELECT country,full_text FROM my_addresses()')).rows,[{country:'IT',full_text:'Synthetic address'}]);
  await actor(other);assert.equal((await db.query('SELECT * FROM my_addresses()')).rowCount,0);
 });
 for(const role of ['anon','authenticated']){
  await test('client cannot truncate addresses',async()=>{
   await db.query(`SET LOCAL ROLE ${role}`);await db.query('SAVEPOINT denied');
   await assert.rejects(()=>db.query('TRUNCATE addresses'),e=>e.code==='42501');await db.query('ROLLBACK TO SAVEPOINT denied');
  });
 }
 // Lock race: a seller UPDATE already waiting when reservation commits must
 // not reopen the freshly reserved listing. Two real connections are used.
 const raceId=await listing(),competitor=await connect();
 const pid=(await competitor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const ownerPid=(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 await competitor.query("SELECT set_config('test.actor',$1,false)",[seller]);await competitor.query('SET ROLE authenticated');
 await db.query('BEGIN');await db.query('SELECT fixture_reserve($1,$2)',[raceId,buyer]);
 const pending=competitor.query("UPDATE listings SET status='active',title='Raced' WHERE id=$1",[raceId]).then(value=>({value}),error=>({error}));
 let blocked=false;
 for(let i=0;i<100;i++){
  const blockers=(await db.query('SELECT pg_blocking_pids($1) AS value',[pid])).rows[0].value;
  if(blockers.includes(ownerPid)){blocked=true;break}await new Promise(resolve=>setTimeout(resolve,20));
 }
 await db.query('COMMIT');const raced=await pending;assert.equal(blocked,true);if(raced.error)throw raced.error;
 assert.equal(raced.value.rowCount,0);assert.equal((await state(raceId)).status,'reserved');count++;
 await competitor.end();
 console.log(`PASS: ${count} PostgreSQL checkout guard checks, including reproduced old policy bypass and actual reservation/update race. Synthetic data only.`);
}
