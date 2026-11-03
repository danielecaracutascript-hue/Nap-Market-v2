-- Reviewed against the supplied function definition and privilege export.
-- Apply explicitly in the Supabase SQL Editor; this file is not auto-deployed.
-- No application function is called and no order data is changed.
BEGIN;

ALTER FUNCTION public.confirm_payment(uuid, text, integer, bigint, text)
  SET search_path = pg_catalog, public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.confirm_payment(uuid, text, integer, bigint, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.confirm_payment(uuid, text, integer, bigint, text)
  TO service_role;

DO $check$
BEGIN
  IF has_function_privilege('anon',
      'public.confirm_payment(uuid,text,integer,bigint,text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
      'public.confirm_payment(uuid,text,integer,bigint,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
      'public.confirm_payment(uuid,text,integer,bigint,text)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'Unexpected confirm_payment privileges; transaction must be rolled back';
  END IF;
END;
$check$;

COMMIT;

SELECT r.rolname,
       has_function_privilege(r.oid,
         'public.confirm_payment(uuid,text,integer,bigint,text)'::regprocedure,
         'EXECUTE') AS can_execute
FROM pg_roles r
WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
ORDER BY r.rolname;
