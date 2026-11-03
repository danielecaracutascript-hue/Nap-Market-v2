-- Preparation only: no legacy order, descriptor, address, funding or PSBT is
-- rewritten. This script does not create an escrow_v2 order or call Bitcoin.
BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.orders') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='public.orders'::regclass AND attname='escrow_protocol' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'orders.escrow_protocol is required before adding the V2 snapshot';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='public.orders'::regclass AND attname IN ('escrow_v2_participants','escrow_v2_witness_script') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'A V2 snapshot column already exists; inspect it before changing schema';
  END IF;
END
$guard$;

ALTER TABLE public.orders
  ADD COLUMN escrow_v2_participants jsonb,
  ADD COLUMN escrow_v2_witness_script text;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_escrow_v2_snapshot_check CHECK (
    (escrow_protocol = 'legacy_v1' AND escrow_v2_participants IS NULL AND escrow_v2_witness_script IS NULL)
    OR
    (escrow_protocol = 'escrow_v2' AND (
      (escrow_v2_participants IS NULL AND escrow_v2_witness_script IS NULL)
      OR
      (jsonb_typeof(escrow_v2_participants) = 'object'
        AND escrow_v2_participants ?& ARRAY['buyer_xpub','seller_xpub','platform_escrow_xpub']
        AND escrow_v2_witness_script ~ '^[0-9a-f]+$')
    ))
  ) NOT VALID;

CREATE OR REPLACE FUNCTION public.set_order_escrow_v2_snapshot(
  p_order uuid, p_actor uuid, p_descriptor text, p_address text,
  p_shipping_address text, p_participants jsonb, p_witness_script text,
  p_expected jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $function$
DECLARE o public.orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id=p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF p_actor IS NULL OR p_actor IS DISTINCT FROM o.buyer_id THEN RAISE EXCEPTION 'Order buyer required'; END IF;
  IF o.status IS DISTINCT FROM 'CREATED' OR o.escrow_protocol IS DISTINCT FROM 'escrow_v2' THEN RAISE EXCEPTION 'Order is not available for Escrow V2'; END IF;
  IF p_expected IS NULL OR jsonb_typeof(p_expected) <> 'object'
    OR (p_expected->>'buyer_id') IS DISTINCT FROM o.buyer_id::text
    OR (p_expected->>'seller_id') IS DISTINCT FROM o.seller_id::text
    OR (p_expected->>'escrow_index') IS DISTINCT FROM o.escrow_index::text
    OR (p_expected->>'expires_at')::timestamptz IS DISTINCT FROM o.expires_at THEN
    RAISE EXCEPTION 'Order details changed during Escrow V2 creation';
  END IF;
  IF o.escrow_address IS NOT NULL THEN
    IF o.escrow_descriptor IS NULL OR o.shipping_address IS NULL
       OR o.escrow_v2_participants IS NULL OR o.escrow_v2_witness_script IS NULL THEN
      RAISE EXCEPTION 'Existing payment details require review';
    END IF;
    RETURN jsonb_build_object('ok',true,'alreadyCreated',true);
  END IF;
  IF o.expires_at IS NULL OR o.expires_at <= clock_timestamp() OR o.escrow_index IS NULL
     OR o.funding_txid IS NOT NULL OR o.funding_vout IS NOT NULL
     OR nullif(trim(p_descriptor),'') IS NULL OR nullif(trim(p_address),'') IS NULL
     OR nullif(trim(p_shipping_address),'') IS NULL
     OR jsonb_typeof(p_participants) <> 'object'
     OR NOT (p_participants ?& ARRAY['buyer_xpub','seller_xpub','platform_escrow_xpub'])
     OR p_witness_script !~ '^[0-9a-f]+$' THEN
    RAISE EXCEPTION 'Escrow V2 payment details require review';
  END IF;
  UPDATE public.orders SET escrow_descriptor=p_descriptor, escrow_address=p_address,
    shipping_address=p_shipping_address, escrow_v2_participants=p_participants,
    escrow_v2_witness_script=p_witness_script, updated_at=now() WHERE id=o.id;
  RETURN jsonb_build_object('ok',true,'alreadyCreated',false);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.set_order_escrow_v2_snapshot(uuid,uuid,text,text,text,jsonb,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_order_escrow_v2_snapshot(uuid,uuid,text,text,text,jsonb,text,jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;

SELECT has_function_privilege('anon','public.set_order_escrow_v2_snapshot(uuid,uuid,text,text,text,jsonb,text,jsonb)','EXECUTE') AS anon,
  has_function_privilege('authenticated','public.set_order_escrow_v2_snapshot(uuid,uuid,text,text,text,jsonb,text,jsonb)','EXECUTE') AS authenticated,
  has_function_privilege('service_role','public.set_order_escrow_v2_snapshot(uuid,uuid,text,text,text,jsonb,text,jsonb)','EXECUTE') AS service_role;
