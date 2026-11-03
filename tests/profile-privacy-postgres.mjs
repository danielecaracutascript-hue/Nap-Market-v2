import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
export async function runProfilePrivacyTests(db,root,connect){
 await db.query(`CREATE ROLE postgres LOGIN NOSUPERUSER NOBYPASSRLS;
 CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
 GRANT pg_read_all_settings TO postgres;
 GRANT anon,authenticated,service_role TO postgres WITH INHERIT FALSE;
 GRANT USAGE,CREATE ON SCHEMA public TO postgres;
 GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
 CREATE SCHEMA auth AUTHORIZATION postgres;GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
 SET ROLE postgres;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
 $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
 CREATE TABLE public.profiles(id uuid PRIMARY KEY,handle text NOT NULL,country char(2) NOT NULL,
 seller_type text NOT NULL,business_info jsonb,wallet_xpub text,created_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
 GRANT SELECT,INSERT,UPDATE,DELETE ON public.profiles TO anon,authenticated;
 GRANT ALL ON public.profiles TO service_role;
 CREATE POLICY "profiles readable" ON public.profiles FOR SELECT USING(true);
 CREATE POLICY "own profile insert" ON public.profiles FOR INSERT WITH CHECK(id=auth.uid());
 CREATE POLICY "own profile update" ON public.profiles FOR UPDATE USING(id=auth.uid());`);
 const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002';
 await db.query(`INSERT INTO public.profiles(id,handle,country,seller_type,business_info,wallet_xpub)
 VALUES($1,'synthetic-buyer','IT','private','{"internal_note":"synthetic-private-note"}','synthetic-buyer-public-key'),
 ($2,'synthetic-seller','IT','professional','{"business_name":"Synthetic Shop","vat_id":"SYNTHETIC-VAT","internal_note":"synthetic-private-note"}','synthetic-seller-public-key')`,[buyer,seller]);
 const anon=await connect('anon'),auth=await connect('authenticated'),service=await connect('service_role');
 await auth.query("SELECT set_config('test.actor',$1,false)",[buyer]);
 assert.equal((await anon.query('SELECT wallet_xpub FROM public.profiles')).rowCount,2);let checks=1;
 const snapshot=async()=>JSON.stringify((await db.query('SELECT * FROM public.profiles ORDER BY id')).rows);
 const before=await snapshot(),patch=fs.readFileSync(path.join(root,'supabase/security/separate-public-profiles.sql'),'utf8');
 await db.query(patch);await db.query(patch);assert.equal(await snapshot(),before);checks++;
 assert.equal((await anon.query('SELECT * FROM public.profiles')).rowCount,0);checks++;
 const hardening=fs.readFileSync(path.join(root,'supabase/security/harden-profile-privileges.sql'),'utf8');
 await db.query(hardening);await db.query(hardening);checks++;
 const privilegeReport=(await db.query(`SELECT
  has_table_privilege('anon','public.profiles','SELECT') AS anon_select,
  has_table_privilege('anon','public.profiles','INSERT') AS anon_insert,
  has_table_privilege('anon','public.profiles','UPDATE') AS anon_update,
  has_table_privilege('anon','public.profiles','DELETE') AS anon_delete,
  has_table_privilege('authenticated','public.profiles','DELETE') AS authenticated_delete,
  has_table_privilege('authenticated','public.profiles','TRUNCATE') AS authenticated_truncate,
  has_column_privilege('authenticated','public.profiles','wallet_xpub','UPDATE') AS wallet_update,
  has_column_privilege('authenticated','public.profiles','created_at','UPDATE') AS created_at_update,
  has_column_privilege('anon','public.profiles','wallet_xpub','SELECT') AS anon_wallet_select`)).rows[0];
 assert.deepEqual(privilegeReport,{anon_select:false,anon_insert:false,anon_update:false,anon_delete:false,
  authenticated_delete:false,authenticated_truncate:false,wallet_update:true,created_at_update:false,anon_wallet_select:false});checks++;
 await assert.rejects(anon.query('SELECT wallet_xpub FROM public.profiles'),e=>e.code==='42501');checks++;
 const own=(await auth.query('SELECT * FROM public.profiles')).rows;
 assert.equal(own.length,1);assert.equal(own[0].id,buyer);assert.equal(own[0].wallet_xpub,'synthetic-buyer-public-key');checks++;
 assert.equal((await service.query('SELECT id,wallet_xpub FROM public.profiles')).rowCount,2);checks++;
 for(const client of [anon,auth,service]){
  const rows=(await client.query('SELECT * FROM public.public_profiles ORDER BY id')).rows;
  assert.equal(rows.length,2);assert.deepEqual(Object.keys(rows[0]).sort(),['id','handle','country','seller_type','business_info'].sort());
  assert.equal(rows[0].business_info,null);assert.deepEqual(rows[1].business_info,{business_name:'Synthetic Shop',vat_id:'SYNTHETIC-VAT'});
  assert.ok(!JSON.stringify(rows).includes('synthetic-private-note'));assert.ok(!JSON.stringify(rows).includes('public-key'));checks++;
 }
 assert.equal((await auth.query("UPDATE public.profiles SET handle='must-not-change' WHERE id=$1",[seller])).rowCount,0);checks++;
 assert.equal((await auth.query("UPDATE public.profiles SET handle='updated-buyer' WHERE id=$1",[buyer])).rowCount,1);
 assert.equal((await auth.query('SELECT wallet_xpub FROM public.profiles WHERE id=$1',[buyer])).rows[0].wallet_xpub,'synthetic-buyer-public-key');checks++;
 await auth.query(`INSERT INTO public.profiles(id,handle,country,seller_type,business_info)
 VALUES($1,'saved-buyer','IT','private',NULL) ON CONFLICT(id) DO UPDATE
 SET handle=excluded.handle,country=excluded.country,seller_type=excluded.seller_type,business_info=excluded.business_info`,[buyer]);
 assert.equal((await auth.query('SELECT wallet_xpub FROM public.profiles WHERE id=$1',[buyer])).rows[0].wallet_xpub,'synthetic-buyer-public-key');checks++;
 await auth.query("UPDATE public.profiles SET wallet_xpub='synthetic-updated-public-key' WHERE id=$1",[buyer]);
 await assert.rejects(auth.query('UPDATE public.profiles SET created_at=now() WHERE id=$1',[buyer]),e=>e.code==='42501');checks++;
 assert.equal((await auth.query('SELECT wallet_xpub FROM public.profiles WHERE id=$1',[buyer])).rows[0].wallet_xpub,'synthetic-updated-public-key');checks++;
 await assert.rejects(auth.query("UPDATE public.public_profiles SET handle='forbidden'"),e=>e.code==='42501');checks++;
 await assert.rejects(anon.query("INSERT INTO public.public_profiles(id,handle) VALUES(gen_random_uuid(),'forbidden')"),e=>e.code==='42501');checks++;
 await auth.query('BEGIN');
 await assert.rejects(auth.query('UPDATE public.profiles SET id=$1 WHERE id=$2',[seller,buyer]),e=>e.code==='42501');
 await auth.query('ROLLBACK');checks++;
 const newId='00000000-0000-4000-8000-000000000003';await auth.query("SELECT set_config('test.actor',$1,false)",[newId]);
 await auth.query("INSERT INTO public.profiles(id,handle,country,seller_type) VALUES($1,'new-synthetic','IT','private')",[newId]);
 assert.equal((await auth.query('SELECT id FROM public.profiles')).rows[0].id,newId);checks++;
 await db.query('CREATE POLICY unexpected_public_read ON public.profiles FOR SELECT USING(true)');
 await assert.rejects(db.query(patch),e=>e.code==='P0001');await db.query('ROLLBACK');
 await db.query('DROP POLICY unexpected_public_read ON public.profiles');checks++;
 await db.query("COMMENT ON VIEW public.public_profiles IS 'Unrelated existing view'");
 await assert.rejects(db.query(patch),e=>e.code==='P0001');await db.query('ROLLBACK');checks++;
 console.log(`PASS: ${checks} profile-privacy PostgreSQL checks. Public projection, owner isolation and service access verified on synthetic data.`);
}
