-- READ ONLY: schema, effective privileges and policies; no profile rows/values.
BEGIN TRANSACTION READ ONLY;
WITH target AS (
 SELECT c.oid,c.relrowsecurity,c.relforcerowsecurity
 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.profiles')
), roles(role_name) AS (VALUES ('anon'),('authenticated'),('service_role'))
SELECT jsonb_build_object(
 'present',EXISTS(SELECT 1 FROM target),
 'table',(SELECT jsonb_build_object('rls',t.relrowsecurity,'force_rls',t.relforcerowsecurity,
  'privileges',(SELECT jsonb_object_agg(r.role_name,jsonb_build_object(
   'select',has_table_privilege(r.role_name,t.oid,'SELECT'),
   'insert',has_table_privilege(r.role_name,t.oid,'INSERT'),
   'update',has_table_privilege(r.role_name,t.oid,'UPDATE'),
   'delete',has_table_privilege(r.role_name,t.oid,'DELETE'),
   'truncate',has_table_privilege(r.role_name,t.oid,'TRUNCATE')
  )) FROM roles r)) FROM target t),
 'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object(
  'name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
  'privileges',(SELECT jsonb_object_agg(r.role_name,jsonb_build_object(
   'select',has_column_privilege(r.role_name,t.oid,a.attnum,'SELECT'),
   'insert',has_column_privilege(r.role_name,t.oid,a.attnum,'INSERT'),
   'update',has_column_privilege(r.role_name,t.oid,a.attnum,'UPDATE')
  )) FROM roles r)
 ) ORDER BY a.attnum),'[]'::jsonb) FROM target t JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid
 WHERE a.attnum>0 AND NOT a.attisdropped),
 'policies',(SELECT coalesce(jsonb_agg(jsonb_build_object(
  'name',policyname,'roles',roles,'command',cmd,'permissive',permissive,
  'using',qual,'with_check',with_check
 ) ORDER BY policyname),'[]'::jsonb) FROM pg_catalog.pg_policies
 WHERE schemaname='public' AND tablename='profiles'),
 'referencing_foreign_keys',(SELECT coalesce(jsonb_agg(jsonb_build_object(
  'table',c.conrelid::regclass::text,'name',c.conname,
  'definition',pg_catalog.pg_get_constraintdef(c.oid)
 ) ORDER BY c.conrelid::regclass::text,c.conname),'[]'::jsonb)
 FROM pg_catalog.pg_constraint c JOIN target t ON c.confrelid=t.oid WHERE c.contype='f'),
 'dependent_views',(SELECT coalesce(jsonb_agg(DISTINCT v.oid::regclass::text),'[]'::jsonb)
 FROM target t JOIN pg_catalog.pg_depend d ON d.refobjid=t.oid AND d.refclassid='pg_class'::regclass
 JOIN pg_catalog.pg_rewrite w ON w.oid=d.objid AND d.classid='pg_rewrite'::regclass
 JOIN pg_catalog.pg_class v ON v.oid=w.ev_class WHERE v.relkind IN ('v','m'))
) AS audit_profile_visibility;
ROLLBACK;
