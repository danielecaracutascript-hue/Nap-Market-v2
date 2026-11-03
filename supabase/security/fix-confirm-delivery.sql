-- Manual security patch: reviewed against the supplied active definition.
-- Changes the function and its permissions; does not call it or update orders.
BEGIN;

CREATE OR REPLACE FUNCTION public.confirm_delivery(p_order uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO o FROM public.orders
  WHERE id = p_order
    AND buyer_id = v_actor
    AND status = 'SHIPPED'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order cannot be confirmed (wrong status, or not your order)';
  END IF;

  UPDATE public.orders
  SET status = 'DELIVERED',
      delivered_at = now(),
      window_ends_at = now() + interval '14 days',
      updated_at = now()
  WHERE id = o.id;

  INSERT INTO public.order_events
    (order_id, actor_id, actor_role, type, data)
  VALUES (o.id, v_actor, 'buyer', 'delivered', '{}'::jsonb);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.confirm_delivery(uuid)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.confirm_delivery(uuid)
TO authenticated, service_role;

DO $check$
BEGIN
  IF has_function_privilege('anon', 'public.confirm_delivery(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.confirm_delivery(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.confirm_delivery(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'Unexpected confirm_delivery privileges; roll back this transaction';
  END IF;
END;
$check$;

COMMIT;

-- Inspection only: this does not execute confirm_delivery.
SELECT p.proname AS function_name,
       p.proconfig AS settings,
       pg_get_functiondef(p.oid) AS definition,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
FROM pg_proc p
WHERE p.oid = 'public.confirm_delivery(uuid)'::regprocedure;
