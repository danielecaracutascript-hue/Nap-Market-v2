-- READ ONLY: verify effective profile privileges after hardening.
BEGIN TRANSACTION READ ONLY;

SELECT jsonb_build_object(
  'table_privileges', jsonb_build_object(
    'anon', jsonb_build_object(
      'select', has_table_privilege('anon','public.profiles','SELECT'),
      'insert', has_table_privilege('anon','public.profiles','INSERT'),
      'update', has_table_privilege('anon','public.profiles','UPDATE'),
      'delete', has_table_privilege('anon','public.profiles','DELETE'),
      'truncate', has_table_privilege('anon','public.profiles','TRUNCATE')
    ),
    'authenticated', jsonb_build_object(
      'select', has_table_privilege('authenticated','public.profiles','SELECT'),
      'insert', has_table_privilege('authenticated','public.profiles','INSERT'),
      'update', has_table_privilege('authenticated','public.profiles','UPDATE'),
      'delete', has_table_privilege('authenticated','public.profiles','DELETE'),
      'truncate', has_table_privilege('authenticated','public.profiles','TRUNCATE')
    ),
    'service_role', jsonb_build_object(
      'select', has_table_privilege('service_role','public.profiles','SELECT'),
      'insert', has_table_privilege('service_role','public.profiles','INSERT'),
      'update', has_table_privilege('service_role','public.profiles','UPDATE'),
      'delete', has_table_privilege('service_role','public.profiles','DELETE'),
      'truncate', has_table_privilege('service_role','public.profiles','TRUNCATE')
    )
  ),
  'column_privileges', jsonb_build_object(
    'authenticated_wallet_xpub_update', has_column_privilege('authenticated','public.profiles','wallet_xpub','UPDATE'),
    'authenticated_created_at_update', has_column_privilege('authenticated','public.profiles','created_at','UPDATE'),
    'anon_wallet_xpub_select', has_column_privilege('anon','public.profiles','wallet_xpub','SELECT')
  ),
  'policies', (
    SELECT jsonb_agg(jsonb_build_object(
      'name', policyname, 'roles', roles, 'command', cmd,
      'using', qual, 'with_check', with_check
    ) ORDER BY policyname)
    FROM pg_catalog.pg_policies
    WHERE schemaname='public' AND tablename='profiles'
  )
) AS profile_privilege_verification;

ROLLBACK;
