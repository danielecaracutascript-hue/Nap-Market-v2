-- No existing rows changed. Apply before relying on the matching UI guard.
BEGIN;
CREATE OR REPLACE FUNCTION public.cancel_order(p_order uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE o public.orders%ROWTYPE;l public.listings%ROWTYPE;v_actor uuid:=auth.uid();
BEGIN
 IF v_actor IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE='42501'; END IF;
 SELECT * INTO o FROM public.orders
 WHERE id=p_order AND buyer_id=v_actor AND status='CREATED' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order cannot be cancelled'; END IF;
 IF o.escrow_address IS NOT NULL OR o.escrow_descriptor IS NOT NULL
  OR o.shipping_address IS NOT NULL OR o.funding_txid IS NOT NULL OR o.funding_vout IS NOT NULL
 THEN RAISE EXCEPTION 'Payment details exist or funding needs review; automatic cancellation is unavailable'; END IF;
 SELECT * INTO l FROM public.listings WHERE id=o.listing_id FOR UPDATE;
 IF NOT FOUND OR l.status IS DISTINCT FROM 'reserved'
 THEN RAISE EXCEPTION 'Listing reservation needs manual review'; END IF;
 IF EXISTS(SELECT 1 FROM public.orders WHERE listing_id=o.listing_id AND id<>o.id
  AND status IS DISTINCT FROM 'CANCELLED' AND status IS DISTINCT FROM 'REFUNDED')
 THEN RAISE EXCEPTION 'Other orders exist for this listing; manual review required'; END IF;
 UPDATE public.orders SET status='CANCELLED',closed_at=now(),updated_at=now() WHERE id=o.id;
 UPDATE public.listings SET status='active' WHERE id=l.id;
 INSERT INTO public.order_events(order_id,actor_id,actor_role,type,data)
 VALUES(o.id,v_actor,'buyer','order_cancelled','{}'::jsonb);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.cancel_order(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.cancel_order(uuid) TO authenticated,service_role;
COMMIT;
SELECT p.proname AS function_name,p.proconfig AS settings,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS service_role
FROM pg_catalog.pg_proc p WHERE p.oid='public.cancel_order(uuid)'::regprocedure;
