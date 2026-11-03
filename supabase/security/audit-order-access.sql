-- Read-only catalog inventory. No business functions are executed and no rows
-- from application tables, credentials, or function bodies are returned.
-- Run the complete file in Supabase SQL Editor; export/copy the audit result.
BEGIN TRANSACTION READ ONLY;

WITH wanted(name) AS (
  VALUES ('confirm_payment'), ('mark_order_funded'), ('set_order_escrow'),
    ('mark_order_released'), ('mark_order_refunded'), ('claim_escrow_submission'),
    ('reconcile_escrow_submission'), ('finalize_order'), ('cancel_order'),
    ('mark_shipped'), ('confirm_delivery'), ('confirm_receipt'),
    ('request_return'), ('ship_return'), ('confirm_return_received'),
    ('open_dispute'), ('decide_dispute'), ('simulate_payment'),
    ('simulate_delivery'), ('test_expire_window'), ('quote_order'),
    ('create_order'), ('my_addresses'), ('save_address')
), functions AS (
  SELECT w.name, p.oid,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
    p.prosecdef AS security_definer,
    pg_catalog.pg_get_userbyid(p.proowner) AS owner,
    ARRAY(SELECT setting FROM unnest(p.proconfig) AS setting
      WHERE setting LIKE 'search_path=%') AS search_path_settings,
    CASE WHEN p.oid IS NOT NULL THEN
      pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') END AS anon,
    CASE WHEN p.oid IS NOT NULL THEN
      pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') END AS authenticated,
    CASE WHEN p.oid IS NOT NULL THEN
      pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') END AS service_role
  FROM wanted w
  LEFT JOIN (pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n
    ON n.oid = p.pronamespace AND n.nspname = 'public') ON p.proname = w.name
), tables AS (
  SELECT c.oid, c.relname AS name, c.relrowsecurity AS rls,
    c.relforcerowsecurity AS force_rls,
    pg_catalog.pg_get_userbyid(c.relowner) AS owner,
    (SELECT jsonb_object_agg(r.role, jsonb_build_object(
      'select', pg_catalog.has_table_privilege(r.role, c.oid, 'SELECT'),
      'insert', pg_catalog.has_table_privilege(r.role, c.oid, 'INSERT'),
      'update', pg_catalog.has_table_privilege(r.role, c.oid, 'UPDATE'),
      'delete', pg_catalog.has_table_privilege(r.role, c.oid, 'DELETE')
    )) FROM (VALUES ('anon'), ('authenticated'), ('service_role')) r(role)) AS privileges
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    AND c.relname IN ('orders', 'order_events', 'psbts', 'disputes',
      'reviews', 'profiles', 'escrow_submission_claims')
)
SELECT jsonb_build_object(
  'functions', (SELECT jsonb_agg(to_jsonb(f) - 'oid' ORDER BY name, arguments) FROM functions f),
  'tables', (SELECT jsonb_agg(to_jsonb(t) - 'oid' ORDER BY name) FROM tables t),
  'policies', (SELECT jsonb_agg(jsonb_build_object(
    'table', p.tablename, 'name', p.policyname, 'permissive', p.permissive,
    'roles', p.roles, 'command', p.cmd
  ) ORDER BY p.tablename, p.policyname)
    FROM pg_catalog.pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename IN (SELECT name FROM tables))
) AS audit;

ROLLBACK;
