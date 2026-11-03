-- Least-privilege access for profiles.
-- Apply after the profile separation migration. No profile data is rewritten.
-- The public_profiles view remains the deliberate public projection; wallet_xpub
-- and all non-projected business_info fields remain outside that view.

BEGIN;

DO $guard$
DECLARE
  profile_oid oid := to_regclass('public.profiles');
  policy_count integer;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Run this migration as postgres';
  END IF;

  IF profile_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
    WHERE oid = profile_oid
      AND relowner = 'postgres'::regrole
      AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'Expected postgres-owned public.profiles with RLS enabled';
  END IF;

  IF NOT (
    SELECT count(*) = 7
    FROM pg_catalog.pg_attribute
    WHERE attrelid = profile_oid
      AND attname IN ('id','handle','country','seller_type','business_info','wallet_xpub','created_at')
      AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'Unexpected profiles schema; review before changing privileges';
  END IF;

  SELECT count(*) INTO policy_count
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'profiles'
    AND policyname IN ('own profile insert','own profile read','own profile update');

  IF policy_count <> 3 OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'profiles'
      AND policyname NOT IN ('own profile insert','own profile read','own profile update')
  ) THEN
    RAISE EXCEPTION 'Unexpected profiles RLS policies; review before changing access';
  END IF;
END;
$guard$;

-- Remove broad table-level and any prior column-level application grants.
REVOKE ALL PRIVILEGES ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES (id, handle, country, seller_type, business_info, wallet_xpub, created_at)
  ON TABLE public.profiles FROM PUBLIC, anon, authenticated;

-- Authenticated users can read only their own row through RLS.
GRANT SELECT ON TABLE public.profiles TO authenticated;

-- Profile creation/editing and wallet registration use only these columns.
-- id remains updateable solely to support the existing PostgREST upsert;
-- the explicit WITH CHECK policy below prevents changing it to another user.
GRANT INSERT (id, handle, country, seller_type, business_info)
  ON TABLE public.profiles TO authenticated;
GRANT UPDATE (id, handle, country, seller_type, business_info, wallet_xpub)
  ON TABLE public.profiles TO authenticated;

-- Backend operations retain their existing full access.
GRANT ALL PRIVILEGES ON TABLE public.profiles TO service_role;

DROP POLICY IF EXISTS "own profile insert" ON public.profiles;
CREATE POLICY "own profile insert"
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "own profile read" ON public.profiles;
CREATE POLICY "own profile read"
  ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS "own profile update" ON public.profiles;
CREATE POLICY "own profile update"
  ON public.profiles FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Post-migration verification: privilege metadata only, no profile values.
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
