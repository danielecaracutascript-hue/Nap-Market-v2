import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// Only called after the runner verifies a freshly created local cluster.
export async function runTableGuardTests(db,root,application=false){
 await db.query(`
 CREATE ROLE postgres NOSUPERUSER NOBYPASSRLS;
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 GRANT USAGE,CREATE ON SCHEMA public TO postgres;
 GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
 SET ROLE postgres;
 CREATE TABLE public.app_settings(key text PRIMARY KEY,value text);
 CREATE TABLE public.arbiters(user_id uuid PRIMARY KEY,active boolean);
 INSERT INTO public.app_settings VALUES('SYNTHETIC_TEST_FLAG','false');
 INSERT INTO public.arbiters VALUES('00000000-0000-4000-8000-000000000001',true);
 ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
 ALTER TABLE public.arbiters ENABLE ROW LEVEL SECURITY;
 GRANT ALL ON public.app_settings,public.arbiters TO anon,authenticated,service_role;
 RESET ROLE;
 `);
 let checks=0;
 const tables=application?['disputes','listings','order_events','orders','profiles','psbts','reviews']:['app_settings','arbiters'];
 if(application){
  await db.query('SET ROLE postgres');
  for(const table of tables)await db.query(`CREATE TABLE public.${table}(id integer PRIMARY KEY,label text);
   INSERT INTO public.${table} VALUES(1,'synthetic'); ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
   GRANT ALL ON public.${table} TO anon,authenticated,service_role`);
  await db.query('RESET ROLE');
 }
 const snapshot=async()=> (await db.query('SELECT jsonb_build_object('+tables.map(table=>`'${table}',(SELECT jsonb_agg(t) FROM public.${table} t)`).join(',')+') AS value')).rows[0].value;
 const initial=await snapshot();
 // Reproduce the supplied permissions: RLS blocks row access, but not TRUNCATE.
 for(const role of ['anon','authenticated']){
  await db.query('BEGIN');await db.query(`SET LOCAL ROLE ${role}`);
  for(const table of tables){
   assert.equal((await db.query(`SELECT * FROM public.${table}`)).rowCount,0);
   await db.query(`TRUNCATE public.${table}`);
  }
  await db.query('ROLLBACK');assert.deepEqual(await snapshot(),initial);checks++;
 }
 const script=fs.readFileSync(path.join(root,'supabase/security',application?'restrict-application-truncate.sql':'restrict-settings-arbiters-truncate.sql'),'utf8');
 await db.query('SET ROLE postgres');
 const install=await db.query(script);
 const expected=tables.map(table_name=>({table_name,anon_truncate:false,authenticated_truncate:false,service_role_truncate:true}));
 assert.deepEqual(install.at(-1).rows,expected);checks++;
 const reinstall=await db.query(script);assert.deepEqual(reinstall.at(-1).rows,expected);checks++;
 await db.query('RESET ROLE');
 for(const role of ['anon','authenticated']){
  for(const table of tables){
   await db.query('BEGIN');await db.query(`SET LOCAL ROLE ${role}`);
   await assert.rejects(()=>db.query(`TRUNCATE public.${table}`),e=>e.code==='42501');
   await db.query('ROLLBACK');assert.deepEqual(await snapshot(),initial);checks++;
  }
 }
 await db.query('BEGIN');await db.query('SET LOCAL ROLE service_role');
 await db.query('TRUNCATE '+tables.map(table=>'public.'+table).join(','));
 await db.query('ROLLBACK');assert.deepEqual(await snapshot(),initial);checks++;
 const role=(await db.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='postgres'")).rows[0];
 assert.deepEqual(role,{rolsuper:false,rolbypassrls:false});checks++;
 console.log(`PASS: ${checks} focused PostgreSQL table-privilege checks; synthetic rows preserved, no remote database or Bitcoin calls.`);
}
