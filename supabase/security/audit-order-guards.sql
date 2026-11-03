-- Read-only follow-up to audit-order-access.sql.
-- Returns selected application function definitions and policy/schema metadata.
-- Does not execute those functions or read application rows.
BEGIN TRANSACTION READ ONLY;

SELECT jsonb_build_object(
  'functions', (
    SELECT jsonb_agg(jsonb_build_object(
      'name', p.proname,
      'arguments', pg_catalog.pg_get_function_identity_arguments(p.oid),
      'definition', pg_catalog.pg_get_functiondef(p.oid)
    ) ORDER BY p.proname, p.oid)
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND p.proname IN (
        'simulate_payment', 'simulate_delivery', 'test_expire_window',
        'set_order_escrow', 'mark_order_funded', 'finalize_order',
        'decide_dispute', 'cancel_order'
      )
  ),
  'policies', (
    SELECT jsonb_agg(jsonb_build_object(
      'table', tablename, 'name', policyname, 'roles', roles,
      'command', cmd, 'using', qual, 'with_check', with_check
    ) ORDER BY tablename, policyname)
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('profiles', 'orders', 'order_events', 'psbts', 'disputes')
  ),
  'profile_columns', (
    SELECT jsonb_agg(jsonb_build_object(
      'name', a.attname,
      'type', pg_catalog.format_type(a.atttypid, a.atttypmod)
    ) ORDER BY a.attnum)
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'profiles'
      AND a.attnum > 0 AND NOT a.attisdropped
  ),
  'public_schema_create', (
    SELECT jsonb_object_agg(role_name,
      pg_catalog.has_schema_privilege(role_name, 'public', 'CREATE'))
    FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role_name)
  )
) AS audit_guards;

ROLLBACK;
