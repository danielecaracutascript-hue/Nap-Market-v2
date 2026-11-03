-- Removes only client TRUNCATE privileges. No rows or policies are changed.
-- RLS does not govern TRUNCATE. Existing service privileges are preserved.
BEGIN;

REVOKE TRUNCATE ON TABLE public.app_settings, public.arbiters
FROM PUBLIC, anon, authenticated;

DO $check$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES ('anon'), ('authenticated')) AS r(role_name)
    CROSS JOIN (VALUES ('public.app_settings'), ('public.arbiters')) AS t(table_name)
    WHERE has_table_privilege(r.role_name, t.table_name, 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION 'Client TRUNCATE still granted through another role; transaction rolled back';
  END IF;
END;
$check$;

COMMIT;

SELECT c.relname AS table_name,
  has_table_privilege('anon', c.oid, 'TRUNCATE') AS anon_truncate,
  has_table_privilege('authenticated', c.oid, 'TRUNCATE') AS authenticated_truncate,
  has_table_privilege('service_role', c.oid, 'TRUNCATE') AS service_role_truncate
FROM pg_class c
WHERE c.oid IN ('public.app_settings'::regclass, 'public.arbiters'::regclass)
ORDER BY c.relname;
