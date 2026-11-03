-- One result only. Catalog metadata, no profile rows or business operations.
SELECT jsonb_build_object(
 'objects',(SELECT jsonb_agg(jsonb_build_object(
  'name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),
  'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
  'anon_select_grant',has_table_privilege('anon',c.oid,'SELECT'),
  'authenticated_select_grant',has_table_privilege('authenticated',c.oid,'SELECT'),
  'service_role_select_grant',has_table_privilege('service_role',c.oid,'SELECT'),
  'anon_update_grant',has_table_privilege('anon',c.oid,'UPDATE'),
  'authenticated_update_grant',has_table_privilege('authenticated',c.oid,'UPDATE')
 ) ORDER BY c.relname) FROM pg_catalog.pg_class c
 WHERE c.oid IN (to_regclass('public.profiles'),to_regclass('public.public_profiles'))),
 'policies',(SELECT jsonb_agg(jsonb_build_object(
  'name',policyname,'roles',roles,'command',cmd,'using',qual,'with_check',with_check
 ) ORDER BY policyname) FROM pg_catalog.pg_policies
 WHERE schemaname='public' AND tablename='profiles'),
 'public_columns',(SELECT jsonb_agg(attname ORDER BY attnum) FROM pg_catalog.pg_attribute
 WHERE attrelid=to_regclass('public.public_profiles') AND attnum>0 AND NOT attisdropped)
) AS profile_separation_verification;
