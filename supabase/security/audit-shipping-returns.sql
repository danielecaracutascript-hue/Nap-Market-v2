-- Read-only catalog inspection. Does not execute business functions or read
-- application rows, settings values, credentials or wallet material.
BEGIN TRANSACTION READ ONLY;

WITH wanted(name) AS (
 VALUES ('mark_shipped'),('confirm_receipt'),('request_return'),
        ('ship_return'),('confirm_return_received')
), targets AS (
 SELECT c.oid,c.relname FROM pg_catalog.pg_class c
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p')
 AND c.relname IN ('orders','order_events','psbts','listings','profiles','reviews','disputes')
)
SELECT jsonb_build_object(
 'functions',(
  SELECT jsonb_agg(jsonb_build_object(
   'name',w.name,'arguments',pg_catalog.pg_get_function_identity_arguments(p.oid),
   'definition',pg_catalog.pg_get_functiondef(p.oid),
   'anon',CASE WHEN p.oid IS NOT NULL THEN pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') END,
   'authenticated',CASE WHEN p.oid IS NOT NULL THEN pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE') END,
   'service_role',CASE WHEN p.oid IS NOT NULL THEN pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE') END
  ) ORDER BY w.name,p.oid)
  FROM wanted w LEFT JOIN (
   pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n
    ON n.oid=p.pronamespace AND n.nspname='public' AND p.prokind='f'
  ) ON p.proname=w.name
 ),
 'order_columns',(
  SELECT jsonb_agg(jsonb_build_object('name',a.attname,
   'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull)
   ORDER BY a.attnum)
  FROM pg_catalog.pg_attribute a JOIN targets t ON t.oid=a.attrelid
  WHERE t.relname='orders' AND a.attnum>0 AND NOT a.attisdropped
 ),
 'constraints',(
  SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',c.conname,
   'type',c.contype,'definition',pg_catalog.pg_get_constraintdef(c.oid)) ORDER BY t.relname,c.conname)
  FROM pg_catalog.pg_constraint c JOIN targets t ON t.oid=c.conrelid
  WHERE t.relname IN ('orders','order_events','psbts','listings')
 ),
 'indexes',(
  SELECT jsonb_agg(jsonb_build_object('table',tablename,'name',indexname,'definition',indexdef)
   ORDER BY tablename,indexname)
  FROM pg_catalog.pg_indexes WHERE schemaname='public'
   AND tablename IN ('orders','order_events','psbts','listings')
 ),
 'triggers',(
  SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',g.tgname,
   'enabled',g.tgenabled,'definition',pg_catalog.pg_get_triggerdef(g.oid)) ORDER BY t.relname,g.tgname)
  FROM pg_catalog.pg_trigger g JOIN targets t ON t.oid=g.tgrelid
  WHERE NOT g.tgisinternal AND t.relname IN ('orders','order_events','psbts','listings')
 ),
 'truncate_privileges',(
  SELECT jsonb_agg(jsonb_build_object('table',t.relname,
   'anon',pg_catalog.has_table_privilege('anon',t.oid,'TRUNCATE'),
   'authenticated',pg_catalog.has_table_privilege('authenticated',t.oid,'TRUNCATE'),
   'service_role',pg_catalog.has_table_privilege('service_role',t.oid,'TRUNCATE')) ORDER BY t.relname)
  FROM targets t
 )
) AS audit_shipping_returns;

ROLLBACK;
