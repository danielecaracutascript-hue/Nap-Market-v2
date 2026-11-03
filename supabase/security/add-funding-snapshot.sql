-- Install before the matching check-payment route. No business function is called
-- during installation. Existing funded orders and legacy RPC are preserved.
BEGIN;
CREATE OR REPLACE FUNCTION public.confirm_order_funding_snapshot(
  p_order uuid, p_actor uuid, p_txid text, p_vout integer, p_height integer,
  p_escrow_sats bigint, p_shipping_sats bigint, p_expected jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  o public.orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF p_actor IS NULL OR (p_actor IS DISTINCT FROM o.buyer_id AND p_actor IS DISTINCT FROM o.seller_id)
  THEN RAISE EXCEPTION 'Order participant required'; END IF;
  IF p_expected IS NULL OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
    OR (p_expected->>'buyer_id') IS DISTINCT FROM o.buyer_id::text
    OR (p_expected->>'seller_id') IS DISTINCT FROM o.seller_id::text
    OR (p_expected->>'price_sats') IS DISTINCT FROM o.price_sats::text
    OR (p_expected->>'buyer_commission_sats') IS DISTINCT FROM o.buyer_commission_sats::text
    OR (p_expected->>'shipping_sats') IS DISTINCT FROM o.shipping_sats::text
    OR (p_expected->>'escrow_descriptor') IS DISTINCT FROM o.escrow_descriptor
    OR (p_expected->>'escrow_index') IS DISTINCT FROM o.escrow_index::text
    OR (p_expected->>'escrow_address') IS DISTINCT FROM o.escrow_address
    OR (p_expected->>'shipping_address') IS DISTINCT FROM o.shipping_address
    OR (p_expected->>'expires_at')::timestamptz IS DISTINCT FROM o.expires_at
  THEN RAISE EXCEPTION 'Order payment details changed; refresh and check again'; END IF;
  IF p_txid IS NULL OR p_txid !~ '^[0-9a-f]{64}$'
    OR p_vout IS NULL OR p_vout < 0 OR p_height IS NULL OR p_height < 0
    OR o.price_sats IS NULL OR o.price_sats <= 0
    OR o.buyer_commission_sats IS NULL OR o.buyer_commission_sats < 0
    OR o.shipping_sats IS NULL OR o.shipping_sats < 0
    OR p_escrow_sats IS DISTINCT FROM (o.price_sats + o.buyer_commission_sats)
    OR p_shipping_sats IS NULL OR p_shipping_sats < o.shipping_sats
    OR nullif(o.escrow_descriptor,'') IS NULL OR o.escrow_index IS NULL OR o.escrow_index < 0
    OR nullif(o.escrow_address,'') IS NULL OR nullif(o.shipping_address,'') IS NULL
  THEN RAISE EXCEPTION 'Invalid verified payment details'; END IF;
  -- Concurrent repeat of the same verified payment is read-only and adds no event.
  IF o.status = 'FUNDED' AND o.funding_txid = p_txid AND o.funding_vout = p_vout THEN
    RETURN jsonb_build_object('ok',true,'alreadyFunded',true);
  END IF;
  IF o.status IS DISTINCT FROM 'CREATED' OR o.expires_at IS NULL OR o.expires_at <= clock_timestamp()
    OR o.funding_txid IS NOT NULL OR o.funding_vout IS NOT NULL
  THEN RAISE EXCEPTION 'Order is not payable or has expired; payment needs review'; END IF;

  PERFORM public.mark_order_funded(p_order,p_txid,p_vout,p_height);
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id=p_order AND status='FUNDED'
    AND funding_txid=p_txid AND funding_vout=p_vout)
  THEN RAISE EXCEPTION 'Legacy funding did not record the verified payment'; END IF;
  RETURN jsonb_build_object('ok',true,'alreadyFunded',false);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.confirm_order_funding_snapshot(uuid,uuid,text,integer,integer,bigint,bigint,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_order_funding_snapshot(uuid,uuid,text,integer,integer,bigint,bigint,jsonb)
  TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
SELECT has_function_privilege('anon','public.confirm_order_funding_snapshot(uuid,uuid,text,integer,integer,bigint,bigint,jsonb)','EXECUTE') AS anon,
  has_function_privilege('authenticated','public.confirm_order_funding_snapshot(uuid,uuid,text,integer,integer,bigint,bigint,jsonb)','EXECUTE') AS authenticated,
  has_function_privilege('service_role','public.confirm_order_funding_snapshot(uuid,uuid,text,integer,integer,bigint,bigint,jsonb)','EXECUTE') AS service_role;
