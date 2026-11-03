-- Catalog inspection only: no address/listing/order rows or settings values.
-- Does not execute any checkout function or change application data.
BEGIN TRANSACTION READ ONLY;
WITH wanted(name) AS (
 VALUES ('create_order'),('quote_order'),('save_address'),('my_addresses'),('cancel_order')
), targets AS (
 SELECT c.oid,c.relname,c.relrowsecurity,c.relforcerowsecurity
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p')
 AND c.relname IN ('listings','addresses','orders')
)
SELECT jsonb_build_object(
 'functions',(
  SELECT jsonb_agg(jsonb_build_object('name',w.name,
   'arguments',pg_catalog.pg_get_function_identity_arguments(p.oid),
   'security_definer',p.prosecdef,'definition',pg_catalog.pg_get_functiondef(p.oid),
   'anon',CASE WHEN p.oid IS NOT NULL THEN pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') END,
   'authenticated',CASE WHEN p.oid IS NOT NULL THEN pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE') END,
   'service_role',CASE WHEN p.oid IS NOT NULL THEN pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE') END
  ) ORDER BY w.name,p.oid)
  FROM wanted w LEFT JOIN (pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n
   ON n.oid=p.pronamespace AND n.nspname='public' AND p.prokind='f') ON p.proname=w.name
 ),
 'tables',(
  SELECT jsonb_agg(jsonb_build_object('name',t.relname,'rls',t.relrowsecurity,
   'force_rls',t.relforcerowsecurity,'privileges',(
    SELECT jsonb_object_agg(r.role_name,jsonb_build_object(
     'select',pg_catalog.has_table_privilege(r.role_name,t.oid,'SELECT'),
     'insert',pg_catalog.has_table_privilege(r.role_name,t.oid,'INSERT'),
     'update',pg_catalog.has_table_privilege(r.role_name,t.oid,'UPDATE'),
     'delete',pg_catalog.has_table_privilege(r.role_name,t.oid,'DELETE'),
     'truncate',pg_catalog.has_table_privilege(r.role_name,t.oid,'TRUNCATE')
    )) FROM (VALUES ('anon'),('authenticated'),('service_role')) r(role_name)
   )) ORDER BY t.relname) FROM targets t
 ),
 'policies',(
  SELECT jsonb_agg(jsonb_build_object('table',tablename,'name',policyname,'roles',roles,
   'command',cmd,'permissive',permissive,'using',qual,'with_check',with_check)
   ORDER BY tablename,policyname)
  FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename IN (SELECT relname FROM targets)
 ),
 'columns',(
  SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',a.attname,
   'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull)
   ORDER BY t.relname,a.attnum)
  FROM pg_catalog.pg_attribute a JOIN targets t ON t.oid=a.attrelid
  WHERE a.attnum>0 AND NOT a.attisdropped AND t.relname IN ('listings','addresses')
 ),
 'constraints',(
  SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',c.conname,
   'definition',pg_catalog.pg_get_constraintdef(c.oid)) ORDER BY t.relname,c.conname)
  FROM pg_catalog.pg_constraint c JOIN targets t ON t.oid=c.conrelid
 ),
 'indexes',(
  SELECT jsonb_agg(jsonb_build_object('table',tablename,'name',indexname,'definition',indexdef)
   ORDER BY tablename,indexname)
  FROM pg_catalog.pg_indexes WHERE schemaname='public' AND tablename IN (SELECT relname FROM targets)
 ),
 'triggers',(
  SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',g.tgname,
   'enabled',g.tgenabled,'definition',pg_catalog.pg_get_triggerdef(g.oid)) ORDER BY t.relname,g.tgname)
  FROM pg_catalog.pg_trigger g JOIN targets t ON t.oid=g.tgrelid WHERE NOT g.tgisinternal
 )
) AS audit_checkout;
ROLLBACK;
