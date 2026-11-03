-- Preserve existing test flags, participant checks, bodies and permissions.
-- Does not call any simulation or modify orders/settings.
BEGIN;
ALTER FUNCTION public.simulate_payment(uuid) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.simulate_delivery(uuid) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.test_expire_window(uuid) SET search_path = pg_catalog, public, pg_temp;
COMMIT;

SELECT p.proname AS function_name, p.proconfig AS settings,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
FROM pg_proc p WHERE p.oid IN (
  'public.simulate_payment(uuid)'::regprocedure,
  'public.simulate_delivery(uuid)'::regprocedure,
  'public.test_expire_window(uuid)'::regprocedure
) ORDER BY p.proname;
