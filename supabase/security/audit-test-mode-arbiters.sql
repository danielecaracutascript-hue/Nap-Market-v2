-- Catalogs only: no app_settings values, user rows, or credentials are read.
-- No application function is executed. Run the complete file.
BEGIN TRANSACTION READ ONLY;

WITH targets(name) AS (VALUES ('app_settings'), ('arbiters')),
tables AS (
  SELECT c.oid, c.relname AS name, c.relrowsecurity AS rls,
    c.relforcerowsecurity AS force_rls,
    pg_catalog.pg_get_userbyid(c.relowner) AS owner,
    (SELECT jsonb_object_agg(r.role_name, jsonb_build_object(
      'select', pg_catalog.has_table_privilege(r.role_name,c.oid,'SELECT'),
      'insert', pg_catalog.has_table_privilege(r.role_name,c.oid,'INSERT'),
      'update', pg_catalog.has_table_privilege(r.role_name,c.oid,'UPDATE'),
      'delete', pg_catalog.has_table_privilege(r.role_name,c.oid,'DELETE'),
      'truncate', pg_catalog.has_table_privilege(r.role_name,c.oid,'TRUNCATE')
    )) FROM (VALUES ('anon'),('authenticated'),('service_role')) r(role_name)) AS privileges,
    (SELECT jsonb_agg(jsonb_build_object(
      'name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
      'anon_insert',pg_catalog.has_column_privilege('anon',c.oid,a.attnum,'INSERT'),
      'anon_update',pg_catalog.has_column_privilege('anon',c.oid,a.attnum,'UPDATE'),
      'authenticated_insert',pg_catalog.has_column_privilege('authenticated',c.oid,a.attnum,'INSERT'),
      'authenticated_update',pg_catalog.has_column_privilege('authenticated',c.oid,a.attnum,'UPDATE')
    ) ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid
        AND a.attnum>0 AND NOT a.attisdropped) AS columns
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname IN (SELECT name FROM targets)
), relevant_functions AS (
  SELECT p.*, n.nspname FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind='f'
    AND (p.proname IN ('is_arbiter_of_order','open_dispute')
      OR p.prosrc ~* '\m(app_settings|arbiters)\M')
)
SELECT jsonb_build_object(
  'tables',(SELECT jsonb_agg(to_jsonb(t)-'oid' ORDER BY name) FROM tables t),
  'missing_tables',(SELECT jsonb_agg(name) FROM targets WHERE name NOT IN (SELECT name FROM tables)),
  'policies',(SELECT jsonb_agg(jsonb_build_object(
    'table',tablename,'name',policyname,'roles',roles,'command',cmd,
    'permissive',permissive,'using',qual,'with_check',with_check
  ) ORDER BY tablename,policyname) FROM pg_catalog.pg_policies
    WHERE schemaname='public' AND tablename IN (SELECT name FROM targets)),
  'functions',(SELECT jsonb_agg(jsonb_build_object(
    'name',p.proname,'arguments',pg_catalog.pg_get_function_identity_arguments(p.oid),
    'security_definer',p.prosecdef,
    'anon',pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE'),
    'authenticated',pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE'),
    'service_role',pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE'),
    'definition',pg_catalog.pg_get_functiondef(p.oid)
  ) ORDER BY p.proname,p.oid) FROM relevant_functions p),
  'triggers',(SELECT jsonb_agg(jsonb_build_object(
    'table',c.relname,'name',t.tgname,'enabled',t.tgenabled,
    'function',t.tgfoid::regprocedure::text
  ) ORDER BY c.relname,t.tgname) FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    WHERE t.tgrelid IN (SELECT oid FROM tables) AND NOT t.tgisinternal)
) AS audit_test_mode_arbiters;

ROLLBACK;
