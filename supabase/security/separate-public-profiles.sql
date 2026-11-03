-- Install together with the matching listing/arbiter/escrow application changes.
-- No existing profile, wallet key or business data is rewritten.
BEGIN;
DO $guard$
BEGIN
 IF current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM pg_class
  WHERE oid='public.profiles'::regclass AND relowner='postgres'::regrole AND relrowsecurity)
 THEN RAISE EXCEPTION 'Expected postgres-owned profiles with RLS enabled'; END IF;
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='profiles'
  AND (cmd='ALL' OR (cmd='SELECT' AND policyname NOT IN ('profiles readable','own profile read'))))
 THEN RAISE EXCEPTION 'Unexpected profile policies; review before restricting reads'; END IF;
 IF to_regclass('public.public_profiles') IS NOT NULL AND
  obj_description(to_regclass('public.public_profiles'),'pg_class') IS DISTINCT FROM 'Nap Market public profile projection v1'
 THEN RAISE EXCEPTION 'public_profiles name already in use; manual review required'; END IF;
END;
$guard$;
CREATE OR REPLACE VIEW public.public_profiles WITH (security_barrier=true) AS
 SELECT id,handle,country,seller_type,
  CASE WHEN seller_type='professional' THEN jsonb_build_object(
   'business_name',business_info->>'business_name','vat_id',business_info->>'vat_id')
  ELSE NULL::jsonb END AS business_info
 FROM public.profiles;
ALTER VIEW public.public_profiles OWNER TO postgres;
COMMENT ON VIEW public.public_profiles IS 'Nap Market public profile projection v1';
REVOKE ALL ON public.public_profiles FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.public_profiles TO anon,authenticated,service_role;
DROP POLICY IF EXISTS "profiles readable" ON public.profiles;
DROP POLICY IF EXISTS "own profile read" ON public.profiles;
CREATE POLICY "own profile read" ON public.profiles FOR SELECT TO authenticated USING(id=auth.uid());
NOTIFY pgrst,'reload schema';
COMMIT;
SELECT c.relname AS object_name,c.relrowsecurity AS rls,
 has_table_privilege('anon',c.oid,'SELECT') AS anon_select_grant,
 has_table_privilege('authenticated',c.oid,'SELECT') AS authenticated_select_grant,
 has_table_privilege('service_role',c.oid,'SELECT') AS service_role_select_grant
FROM pg_class c WHERE c.oid IN ('public.profiles'::regclass,'public.public_profiles'::regclass)
ORDER BY c.relname;
SELECT policyname,roles,cmd,qual AS policy_using,with_check FROM pg_policies
WHERE schemaname='public' AND tablename='profiles' ORDER BY policyname;
SELECT array_agg(attname ORDER BY attnum) AS public_columns FROM pg_attribute
WHERE attrelid='public.public_profiles'::regclass AND attnum>0 AND NOT attisdropped;
