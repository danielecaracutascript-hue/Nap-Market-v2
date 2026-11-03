import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
export async function runRemainingRpcPathTests(db,root){
 await db.query('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;');
 const signatures=[
  ['is_arbiter_of_listing(uuid)',true],['is_arbiter_of_order(uuid)',true],
  ['mark_order_funded(uuid,text,integer,integer)',false],['mark_order_refunded(uuid,text)',false],
  ['mark_order_released(uuid,text)',false],['set_order_escrow(uuid,text,text,text)',false],
 ];
 for(const [signature,helper] of signatures){
  // Fixed test identifiers only. Sentinel bodies must never execute.
  await db.query(`CREATE FUNCTION public.${signature} RETURNS void LANGUAGE plpgsql SECURITY DEFINER
   SET search_path=public AS $$ BEGIN RAISE EXCEPTION 'Metadata test must never execute a business function'; END; $$;`);
  if(!helper)await db.query(`REVOKE EXECUTE ON FUNCTION public.${signature} FROM PUBLIC,anon,authenticated;
   GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
 }
 const before=(await db.query(`SELECT oid::regprocedure::text AS signature,prosrc,proacl,prosecdef,provolatile
  FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid`)).rows;
 const patch=fs.readFileSync(path.join(root,'supabase/security/harden-remaining-rpc-search-paths.sql'),'utf8');
 const result=(await db.query(patch)).at(-1).rows;
 assert.equal(result.length,6);let checks=0;
 for(const [signature,helper] of signatures){
  const row=result.find(row=>row.function_name==='public.'+signature);
  assert.deepEqual(row.settings,['search_path=pg_catalog, public, pg_temp']);
  assert.equal(row.anon,helper);assert.equal(row.authenticated,helper);assert.equal(row.service_role,true);checks++;
 }
 const after=(await db.query(`SELECT oid::regprocedure::text AS signature,prosrc,proacl,prosecdef,provolatile
  FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid`)).rows;
 assert.deepEqual(after,before);checks++;
 assert.deepEqual((await db.query(patch)).at(-1).rows,result);checks++;
 console.log(`PASS: ${checks} remaining-RPC metadata checks. Bodies, ACL, volatility and SECURITY DEFINER preserved; no business functions called.`);
}
