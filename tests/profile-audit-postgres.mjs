import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
export async function runProfileAuditTests(db,root){
 await db.query('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;');
 const sql=fs.readFileSync(path.join(root,'supabase/security/audit-profile-visibility.sql'),'utf8');
 const read=async()=>{
  const result=await db.query(sql);return result.find(part=>part.rows?.[0]?.audit_profile_visibility)?.rows[0].audit_profile_visibility;
 };
 let report=await read(),checks=0;
 assert.equal(report.present,false);assert.deepEqual(report.columns,[]);checks++;
 await db.query(`CREATE TABLE public.profiles(id uuid PRIMARY KEY,handle text,country text,wallet_xpub text,business_info jsonb);
  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  GRANT SELECT,INSERT,UPDATE ON public.profiles TO anon,authenticated;
  CREATE POLICY public_profile_read ON public.profiles FOR SELECT USING(true);
  CREATE TABLE public.listings(id uuid,seller_id uuid REFERENCES public.profiles(id));
  CREATE VIEW public.profile_names AS SELECT id,handle FROM public.profiles;
  INSERT INTO public.profiles VALUES(gen_random_uuid(),'synthetic-private-marker','IT','synthetic-public-key-marker','{"business_name":"synthetic-business-marker"}');`);
 report=await read();assert.equal(report.present,true);assert.equal(report.table.rls,true);checks++;
 const column=name=>report.columns.find(column=>column.name===name);
 assert.equal(column('wallet_xpub').privileges.anon.select,true);
 assert.equal(column('business_info').privileges.authenticated.update,true);checks++;
 assert.equal(report.policies[0].using,'true');assert.equal(report.policies[0].command,'SELECT');checks++;
 assert.equal(report.referencing_foreign_keys[0].table,'listings');assert.deepEqual(report.dependent_views,['profile_names']);checks++;
 assert.ok(!JSON.stringify(report).includes('synthetic-'));checks++;
 await db.query('REVOKE SELECT ON public.profiles FROM anon;GRANT SELECT(id,handle) ON public.profiles TO anon');
 report=await read();assert.equal(report.table.privileges.anon.select,false);
 assert.equal(column('id').privileges.anon.select,true);assert.equal(column('wallet_xpub').privileges.anon.select,false);checks++;
 assert.equal((await db.query('SELECT count(*)::int AS n FROM public.profiles')).rows[0].n,1);checks++;
 console.log(`PASS: ${checks} profile-visibility catalog scenarios. Audit reports metadata only; synthetic profile preserved.`);
}
