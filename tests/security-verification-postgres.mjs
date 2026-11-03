import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
export async function runSecurityVerificationTests(db,root){
 await db.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
 CREATE TABLE public.orders(id uuid,buyer_id uuid,status text,delivered_at timestamptz,window_ends_at timestamptz,updated_at timestamptz);
 CREATE TABLE public.order_events(order_id uuid,actor_id uuid,actor_role text,type text,data jsonb);`);
 const audit=fs.readFileSync(path.join(root,'supabase/security/verify-reviewed-functions.sql'),'utf8');
 const read=async()=>{
  const result=await db.query(audit);return result.find(part=>part.rows?.[0]?.security_verification)?.rows[0].security_verification;
 };
 let report=await read(),checks=0;
 assert.equal(report.reviewed_functions.length,13);
 assert.ok(report.reviewed_functions.every(row=>!row.present&&!row.body_matches&&!row.access_matches));checks++;
 await db.query(fs.readFileSync(path.join(root,'supabase/security/fix-confirm-delivery.sql'),'utf8'));
 report=await read();const match=()=>report.reviewed_functions.find(row=>row.function==='public.confirm_delivery(uuid)');
 assert.equal(match().present,true);assert.equal(match().body_matches,true);assert.equal(match().access_matches,true);
 assert.equal(match().search_path_matches,true);assert.equal(match().security_definer,true);checks++;
 await db.query("ALTER FUNCTION public.confirm_delivery(uuid) SET search_path TO public");
 report=await read();assert.equal(match().body_matches,true);assert.equal(match().search_path_matches,false);checks++;
 await db.query('GRANT EXECUTE ON FUNCTION public.confirm_delivery(uuid) TO PUBLIC');
 report=await read();assert.equal(match().access_matches,false);assert.equal(match().public_execute,true);checks++;
 await db.query(`CREATE OR REPLACE FUNCTION public.confirm_delivery(p_order uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 AS $$ BEGIN RAISE EXCEPTION 'Verification must never call this function'; END; $$;`);
 report=await read();assert.equal(match().body_matches,false);checks++;
 await db.query(`CREATE FUNCTION public.extra_unreviewed() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 AS $$ BEGIN RAISE EXCEPTION 'Catalog check must never call this function'; END; $$;`);
 report=await read();assert.ok(report.other_security_definer_functions.some(row=>row.function==='extra_unreviewed()'));checks++;
 await db.query("ALTER FUNCTION public.extra_unreviewed() SET test.sensitive_setting TO 'synthetic-hidden-value'");
 report=await read();assert.ok(!JSON.stringify(report).includes('synthetic-hidden-value'));checks++;
 assert.equal((await db.query('SELECT count(*)::int AS n FROM public.orders')).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM public.order_events')).rows[0].n,0);checks++;
 console.log(`PASS: ${checks} deployment-verification catalog scenarios. No application function executed or business row changed.`);
}
