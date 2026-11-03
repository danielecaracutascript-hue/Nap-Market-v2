-- Commercial order completion only; never finalizes a Bitcoin transaction.
-- Metadata only: installed body, deadlines and existing rows are preserved.
BEGIN;
ALTER FUNCTION public.finalize_order(uuid) SET search_path TO pg_catalog,public,pg_temp;
REVOKE EXECUTE ON FUNCTION public.finalize_order(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.finalize_order(uuid) TO authenticated,service_role;
COMMIT;
SELECT p.proname AS function_name,p.proconfig AS settings,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS service_role
FROM pg_catalog.pg_proc p WHERE p.oid='public.finalize_order(uuid)'::regprocedure;
