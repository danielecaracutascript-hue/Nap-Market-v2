-- Metadata only. Preserves installed bodies, EXECUTE grants and business data.
-- In particular, arbiter helper access may be required by existing RLS policies.
BEGIN;
ALTER FUNCTION public.is_arbiter_of_listing(uuid) SET search_path TO pg_catalog,public,pg_temp;
ALTER FUNCTION public.is_arbiter_of_order(uuid) SET search_path TO pg_catalog,public,pg_temp;
ALTER FUNCTION public.mark_order_funded(uuid,text,integer,integer) SET search_path TO pg_catalog,public,pg_temp;
ALTER FUNCTION public.mark_order_refunded(uuid,text) SET search_path TO pg_catalog,public,pg_temp;
ALTER FUNCTION public.mark_order_released(uuid,text) SET search_path TO pg_catalog,public,pg_temp;
ALTER FUNCTION public.set_order_escrow(uuid,text,text,text) SET search_path TO pg_catalog,public,pg_temp;
COMMIT;
WITH targets(signature) AS (VALUES
 ('public.is_arbiter_of_listing(uuid)'),('public.is_arbiter_of_order(uuid)'),
 ('public.mark_order_funded(uuid,text,integer,integer)'),('public.mark_order_refunded(uuid,text)'),
 ('public.mark_order_released(uuid,text)'),('public.set_order_escrow(uuid,text,text,text)'))
SELECT t.signature AS function_name,
 ARRAY(SELECT setting FROM unnest(p.proconfig) AS setting WHERE setting LIKE 'search_path=%') AS settings,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS service_role
FROM targets t JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(t.signature)
ORDER BY t.signature;
