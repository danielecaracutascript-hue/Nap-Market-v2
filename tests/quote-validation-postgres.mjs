import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function runQuoteTests(db,root){
 await db.query(`CREATE ROLE postgres NOSUPERUSER NOBYPASSRLS;
 CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 GRANT USAGE,CREATE ON SCHEMA public TO postgres;
 GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
 SET ROLE postgres;
 CREATE TABLE listings(id uuid PRIMARY KEY,status text,price_eur_cents integer,ship_from_country char(2),package_size text);
 CREATE TABLE fx_rates(btc_eur numeric,fetched_at timestamptz);
 CREATE TABLE shipping_rates(from_country char(2),to_country char(2),package_size text,price_eur_cents integer);
 CREATE TABLE orders(id uuid,status text);
 INSERT INTO listings VALUES('00000000-0000-4000-8000-000000000001','active',10000,'IT','small');
 INSERT INTO fx_rates VALUES(100000,now());
 INSERT INTO shipping_rates VALUES('IT','IT','small',1000);
 INSERT INTO orders VALUES('00000000-0000-4000-8000-000000000002','FUNDED');`);
 const script=fs.readFileSync(path.join(root,'supabase/security/fix-quote-validation.sql'),'utf8');
 assert.deepEqual((await db.query(script)).at(-1).rows[0],{function_name:'quote_order',settings:['search_path=pg_catalog, public, pg_temp'],anon:false,authenticated:true,service_role:true});
 await db.query(script);let count=2;
 const id='00000000-0000-4000-8000-000000000001';
 const quote=destination=>db.query('SELECT quote_order($1,$2) AS value',[id,destination]);
 const snapshot=async()=> (await db.query(`SELECT jsonb_build_object(
 'listings',(SELECT jsonb_agg(l) FROM listings l),'orders',(SELECT jsonb_agg(o) FROM orders o),
 'rates',(SELECT jsonb_agg(r) FROM fx_rates r),'shipping',(SELECT jsonb_agg(s) FROM shipping_rates s)) AS value`)).rows[0].value;
 const test=async(name,fn)=>{await db.query('BEGIN');try{await fn();count++;console.log('PASS: '+name)}finally{await db.query('ROLLBACK')}};
 const rejected=async(destination='IT')=>{
  const before=await snapshot();await db.query('SAVEPOINT invalid');
  await assert.rejects(()=>quote(destination),e=>e.code==='P0001');
  await db.query('ROLLBACK TO SAVEPOINT invalid');assert.deepEqual(await snapshot(),before);
 };
 for(const rate of ['0','-1','NaN','Infinity','-Infinity','0.00000000000001','1000000000000000000']){
  await test('invalid or unusable rate rejected without writes',async()=>{
   await db.query('UPDATE fx_rates SET btc_eur=$1',[rate]);await rejected();
  });
 }
 await test('missing rate rejected',async()=>{await db.query('DELETE FROM fx_rates');await rejected()});
 for(const destination of [null,'11','ITA','DE'])await test('invalid or unavailable destination rejected',()=>rejected(destination));
 await test('negative shipping rate rejected',async()=>{await db.query('UPDATE shipping_rates SET price_eur_cents=-1');await rejected()});
 await test('inactive listing rejected',async()=>{await db.query("UPDATE listings SET status='reserved'");await rejected()});
 await test('valid quote retains exact original arithmetic and normalization',async()=>{
  const before=await snapshot();await db.query('SET LOCAL ROLE authenticated');
  const result=(await quote(' it ')).rows[0].value;
  assert.deepEqual(result,{price_eur_cents:10000,buyer_fee_eur_cents:400,shipping_eur_cents:1000,total_eur_cents:11400,
   btc_eur:100000,price_sats:100000,buyer_commission_sats:4000,seller_commission_sats:4000,shipping_sats:10000});
  await db.query('SET LOCAL ROLE postgres');assert.deepEqual(await snapshot(),before);
 });
 await test('anonymous execution denied',async()=>{
  await db.query('SET LOCAL ROLE anon');await db.query('SAVEPOINT denied');
  await assert.rejects(()=>quote('IT'),e=>e.code==='42501');await db.query('ROLLBACK TO SAVEPOINT denied');
 });
 console.log(`PASS: ${count} PostgreSQL quote checks. Synthetic rates/listings only; existing funded fixture unchanged. No Bitcoin calls.`);
}
