-- Reviewed against the active definitions supplied on 2026-10-30.
-- Updates code/settings only. Does not ship, complete or refund any order.
BEGIN;
CREATE OR REPLACE FUNCTION public.mark_shipped(p_order uuid,p_carrier text,p_tracking text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE o public.orders%ROWTYPE;
BEGIN
 IF p_carrier IS NULL OR char_length(trim(p_carrier)) < 2 THEN RAISE EXCEPTION 'Carrier is required'; END IF;
 IF p_tracking IS NULL OR char_length(trim(p_tracking)) < 5 THEN RAISE EXCEPTION 'Tracking number is too short'; END IF;
 SELECT * INTO o FROM public.orders
  WHERE id=p_order AND seller_id=auth.uid() AND status='FUNDED' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order cannot be marked as shipped (wrong status, or not your order)'; END IF;
 UPDATE public.orders SET status='SHIPPED',carrier=trim(p_carrier),tracking_number=trim(p_tracking),
  shipped_at=now(),updated_at=now() WHERE id=p_order;
 INSERT INTO public.order_events(order_id,actor_id,actor_role,type,data)
 VALUES(p_order,auth.uid(),'seller','shipped',jsonb_build_object('carrier',trim(p_carrier),'tracking',trim(p_tracking)));
END $function$;

CREATE OR REPLACE FUNCTION public.ship_return(p_order uuid,p_tracking text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE o public.orders%ROWTYPE;
BEGIN
 IF p_tracking IS NULL OR char_length(trim(p_tracking)) < 5 THEN RAISE EXCEPTION 'Tracking number is too short'; END IF;
 SELECT * INTO o FROM public.orders
  WHERE id=p_order AND buyer_id=auth.uid() AND status='RETURN_REQUESTED'
    AND return_deadline > now() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Return cannot be shipped (wrong status, or the deadline has passed)'; END IF;
 UPDATE public.orders SET status='RETURN_SHIPPED',return_tracking_number=trim(p_tracking),updated_at=now() WHERE id=p_order;
 INSERT INTO public.order_events(order_id,actor_id,actor_role,type,data)
 VALUES(p_order,auth.uid(),'buyer','return_shipped',jsonb_build_object('tracking',trim(p_tracking)));
END $function$;

ALTER FUNCTION public.confirm_receipt(uuid) SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION public.request_return(uuid) SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION public.confirm_return_received(uuid) SET search_path=pg_catalog,public,pg_temp;
REVOKE EXECUTE ON FUNCTION public.mark_shipped(uuid,text,text),public.ship_return(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.mark_shipped(uuid,text,text),public.ship_return(uuid,text) TO authenticated,service_role;
COMMIT;
SELECT p.proname AS function_name,p.proconfig AS settings,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS service_role
FROM pg_proc p WHERE p.oid IN ('public.mark_shipped(uuid,text,text)'::regprocedure,
 'public.ship_return(uuid,text)'::regprocedure,'public.confirm_receipt(uuid)'::regprocedure,
 'public.request_return(uuid)'::regprocedure,'public.confirm_return_received(uuid)'::regprocedure)
ORDER BY p.proname;
