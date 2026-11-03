-- Only removes client TRUNCATE grants. No rows, policies or business functions
-- are changed; existing service privileges are preserved. No TRUNCATE is run.
BEGIN;
REVOKE TRUNCATE ON TABLE public.orders,public.order_events,public.psbts,
 public.listings,public.profiles,public.reviews,public.disputes
FROM PUBLIC,anon,authenticated;
DO $check$ BEGIN
 IF EXISTS (
  SELECT 1 FROM (VALUES ('anon'),('authenticated')) r(role_name)
  CROSS JOIN (VALUES ('public.orders'),('public.order_events'),('public.psbts'),
   ('public.listings'),('public.profiles'),('public.reviews'),('public.disputes')) t(table_name)
  WHERE has_table_privilege(r.role_name,t.table_name,'TRUNCATE')
 ) THEN RAISE EXCEPTION 'Client TRUNCATE still inherited from another role; transaction rolled back'; END IF;
END $check$;
COMMIT;
SELECT c.relname AS table_name,
 has_table_privilege('anon',c.oid,'TRUNCATE') AS anon_truncate,
 has_table_privilege('authenticated',c.oid,'TRUNCATE') AS authenticated_truncate,
 has_table_privilege('service_role',c.oid,'TRUNCATE') AS service_role_truncate
FROM pg_class c WHERE c.oid IN ('public.orders'::regclass,'public.order_events'::regclass,
 'public.psbts'::regclass,'public.listings'::regclass,'public.profiles'::regclass,
 'public.reviews'::regclass,'public.disputes'::regclass)
ORDER BY c.relname;
