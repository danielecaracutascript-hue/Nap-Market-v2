-- Install before using the matching escrow creation route.
-- Installation does not call the function or modify existing orders.
BEGIN;
CREATE OR REPLACE FUNCTION public.set_order_escrow_snapshot(
  p_order uuid, p_actor uuid, p_descriptor text, p_address text,
  p_shipping_address text, p_expected jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE o public.orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id=p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF p_actor IS NULL OR p_actor IS DISTINCT FROM o.buyer_id
  THEN RAISE EXCEPTION 'Order buyer required'; END IF;
  IF o.status IS DISTINCT FROM 'CREATED'
  THEN RAISE EXCEPTION 'Order is not waiting for payment'; END IF;
  IF p_expected IS NULL OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
    OR (p_expected->>'buyer_id') IS DISTINCT FROM o.buyer_id::text
    OR (p_expected->>'seller_id') IS DISTINCT FROM o.seller_id::text
    OR (p_expected->>'escrow_index') IS DISTINCT FROM o.escrow_index::text
    OR (p_expected->>'expires_at')::timestamptz IS DISTINCT FROM o.expires_at
  THEN RAISE EXCEPTION 'Order details changed during escrow creation'; END IF;

  -- A concurrent winner is preserved, even if it used different generated data.
  -- The caller must reload the order and use only the stored addresses.
  IF o.escrow_address IS NOT NULL THEN
    IF nullif(o.escrow_address,'') IS NULL OR nullif(o.escrow_descriptor,'') IS NULL
      OR nullif(o.shipping_address,'') IS NULL
    THEN RAISE EXCEPTION 'Existing payment details require review'; END IF;
    RETURN jsonb_build_object('ok',true,'alreadyCreated',true);
  END IF;
  IF o.expires_at IS NULL OR o.expires_at <= clock_timestamp()
    OR o.escrow_index IS NULL OR o.escrow_index < 0 OR o.escrow_index > 10000
    OR o.funding_txid IS NOT NULL OR o.funding_vout IS NOT NULL
    OR o.escrow_descriptor IS NOT NULL OR o.shipping_address IS NOT NULL
    OR nullif(trim(p_descriptor),'') IS NULL OR nullif(trim(p_address),'') IS NULL
    OR nullif(trim(p_shipping_address),'') IS NULL
  THEN RAISE EXCEPTION 'Order is expired or payment details require review'; END IF;

  PERFORM public.set_order_escrow(p_order,p_descriptor,p_address,p_shipping_address);
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id=p_order AND status='CREATED'
    AND escrow_descriptor=p_descriptor AND escrow_address=p_address AND shipping_address=p_shipping_address)
  THEN RAISE EXCEPTION 'Legacy escrow creation did not save the expected details'; END IF;
  RETURN jsonb_build_object('ok',true,'alreadyCreated',false);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.set_order_escrow_snapshot(uuid,uuid,text,text,text,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_order_escrow_snapshot(uuid,uuid,text,text,text,jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;

SELECT has_function_privilege('anon','public.set_order_escrow_snapshot(uuid,uuid,text,text,text,jsonb)','EXECUTE') AS anon,
  has_function_privilege('authenticated','public.set_order_escrow_snapshot(uuid,uuid,text,text,text,jsonb)','EXECUTE') AS authenticated,
  has_function_privilege('service_role','public.set_order_escrow_snapshot(uuid,uuid,text,text,text,jsonb)','EXECUTE') AS service_role;
