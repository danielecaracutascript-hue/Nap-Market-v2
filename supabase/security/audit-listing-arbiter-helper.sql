-- Catalogs only: reads no listings, profiles, orders, or credentials.
-- Does not execute application functions or change database state.
BEGIN TRANSACTION READ ONLY;

WITH helper AS (
  SELECT p.oid, n.nspname, p.proname,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
    p.prosecdef AS security_definer,
    p.proconfig,
    pg_catalog.pg_get_functiondef(p.oid) AS definition
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE p.oid = 'public.is_arbiter_of_listing(uuid)'::regprocedure
), policies AS (
  SELECT schemaname, tablename, policyname, roles, cmd, permissive,
    qual AS policy_using, with_check AS policy_check
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'
    AND (coalesce(qual, '') ~ '\mis_arbiter_of_listing\M'
      OR coalesce(with_check, '') ~ '\mis_arbiter_of_listing\M')
), callers AS (
  SELECT n.nspname AS schema, p.proname,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
    p.prosecdef AS security_definer,
    ARRAY(SELECT setting FROM unnest(p.proconfig) AS setting
      WHERE setting LIKE 'search_path=%') AS search_path,
    pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
    pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
    pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
    pg_catalog.pg_get_functiondef(p.oid) AS definition
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f'
    AND p.oid <> 'public.is_arbiter_of_listing(uuid)'::regprocedure
    AND p.prosrc ~ '\mis_arbiter_of_listing\M'
)
SELECT jsonb_build_object(
  'helper', (SELECT jsonb_build_object(
    'name', h.nspname || '.' || h.proname,
    'arguments', h.arguments,
    'security_definer', h.security_definer,
    'search_path', ARRAY(SELECT setting FROM unnest(h.proconfig) AS setting
      WHERE setting LIKE 'search_path=%'),
    'anon', pg_catalog.has_function_privilege('anon', h.oid, 'EXECUTE'),
    'authenticated', pg_catalog.has_function_privilege('authenticated', h.oid, 'EXECUTE'),
    'service_role', pg_catalog.has_function_privilege('service_role', h.oid, 'EXECUTE'),
    'definition', h.definition
  ) FROM helper h),
  'dependent_policies', (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.tablename, p.policyname), '[]'::jsonb) FROM policies p),
  'function_callers', (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.proname, c.arguments), '[]'::jsonb) FROM callers c)
) AS audit_listing_arbiter_helper;

ROLLBACK;
