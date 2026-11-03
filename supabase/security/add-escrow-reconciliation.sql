-- Install once as postgres. This creates a server-only reconciliation function.
-- Installation does not call it, change orders, or contact Bitcoin Core.
BEGIN;

CREATE FUNCTION public.reconcile_escrow_submission(p_order uuid, p_claim_id uuid, p_txid text, p_expected jsonb, p_confirmed boolean DEFAULT true, p_psbt text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  c public.escrow_submission_claims%ROWTYPE;
  p public.psbts%ROWTYPE;
  recorded_txid text;
BEGIN
  -- Same lock order as claim_escrow_submission, for concurrent retries.
  SELECT * INTO o FROM public.orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  SELECT * INTO c FROM public.escrow_submission_claims
    WHERE order_id = p_order AND claim_id = p_claim_id AND txid = p_txid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reservation does not match'; END IF;
  IF c.funding_txid IS DISTINCT FROM lower(o.funding_txid)
     OR c.funding_vout IS DISTINCT FROM o.funding_vout
     OR (c.purpose = 'release' AND (o.status IS DISTINCT FROM 'COMPLETED' OR o.refunded_txid IS NOT NULL))
     OR (c.purpose = 'refund' AND (o.status IS DISTINCT FROM 'REFUNDED' OR o.released_txid IS NOT NULL))
  THEN RAISE EXCEPTION 'Order settlement needs review'; END IF;

  SELECT * INTO p FROM public.psbts
    WHERE id::text = c.psbt_id AND order_id = p_order AND purpose = c.purpose FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Prepared transaction not found'; END IF;
  -- Bind the database writes to the exact order/draft read by the proof checker.
  IF p_confirmed IS NULL OR (p_confirmed AND p_psbt IS NOT NULL)
     OR p_expected IS NULL OR jsonb_typeof(p_expected) <> 'object'
     OR (p_expected->>'escrow_descriptor') IS DISTINCT FROM o.escrow_descriptor
     OR (p_expected->>'escrow_address') IS DISTINCT FROM o.escrow_address
     OR (p_expected->>'escrow_index') IS DISTINCT FROM o.escrow_index::text
     OR (p_expected->>'price_sats') IS DISTINCT FROM o.price_sats::text
     OR (p_expected->>'buyer_commission_sats') IS DISTINCT FROM o.buyer_commission_sats::text
     OR (p_expected->>'seller_commission_sats') IS DISTINCT FROM o.seller_commission_sats::text
     OR (p_expected->>'psbt') IS DISTINCT FROM p.psbt
  THEN RAISE EXCEPTION 'The verified order or draft changed during reconciliation'; END IF;
  IF (p.txid IS NOT NULL AND p.txid <> p_txid)
     OR p.status IS NULL OR p.status NOT IN ('draft', 'partial', 'broadcast', 'confirmed')
  THEN RAISE EXCEPTION 'Prepared transaction conflicts with the reservation'; END IF;

  recorded_txid := CASE WHEN c.purpose = 'release' THEN o.released_txid ELSE o.refunded_txid END;
  IF recorded_txid IS NOT NULL AND recorded_txid <> p_txid
  THEN RAISE EXCEPTION 'A different transaction is recorded'; END IF;

  -- Preserve the installed legacy functions and their business/event behavior.
  -- Skip them on retries when the same transaction is already recorded.
  IF recorded_txid IS NULL THEN
    IF c.purpose = 'release' THEN
      PERFORM public.mark_order_released(p_order, p_txid);
    ELSE
      PERFORM public.mark_order_refunded(p_order, p_txid);
    END IF;
  END IF;
  SELECT CASE WHEN c.purpose = 'release' THEN released_txid ELSE refunded_txid END
    INTO recorded_txid FROM public.orders WHERE id = p_order;
  IF recorded_txid IS DISTINCT FROM p_txid
  THEN RAISE EXCEPTION 'Legacy settlement did not record the expected transaction'; END IF;

  -- Confirmed proof preserves PSBT bytes. An acknowledged submit may persist its
  -- signed PSBT without downgrading a confirmation recorded by another request.
  UPDATE public.psbts SET
    status = CASE WHEN p_confirmed OR status = 'confirmed' THEN 'confirmed' ELSE 'broadcast' END,
    txid = p_txid, psbt = coalesce(p_psbt, psbt),
    signed_by = CASE WHEN p_psbt IS NULL THEN signed_by ELSE
      (jsonb_populate_record(NULL::public.psbts, jsonb_build_object('signed_by',
        jsonb_build_array(CASE WHEN c.purpose = 'release' THEN 'seller' ELSE 'buyer' END, 'platform')))).signed_by END
    WHERE id = p.id;
  UPDATE public.escrow_submission_claims
    SET state = 'reconciled', acknowledged_at = coalesce(acknowledged_at, now())
    WHERE order_id = p_order;
  RETURN jsonb_build_object('ok', true, 'txid', p_txid, 'reconciled', true, 'confirmed', p_confirmed OR p.status = 'confirmed');
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reconcile_escrow_submission(uuid,uuid,text,jsonb,boolean,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_escrow_submission(uuid,uuid,text,jsonb,boolean,text) TO service_role;

DO $permissions$
BEGIN
  IF has_function_privilege('anon', 'public.reconcile_escrow_submission(uuid,uuid,text,jsonb,boolean,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reconcile_escrow_submission(uuid,uuid,text,jsonb,boolean,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.reconcile_escrow_submission(uuid,uuid,text,jsonb,boolean,text)', 'EXECUTE')
  THEN RAISE EXCEPTION 'Unexpected reconciliation permissions; roll back this transaction'; END IF;
END;
$permissions$;
NOTIFY pgrst, 'reload schema';
COMMIT;

SELECT has_function_privilege('anon', 'public.reconcile_escrow_submission(uuid,uuid,text,jsonb,boolean,text)', 'EXECUTE') AS anon,
  has_function_privilege('authenticated', 'public.reconcile_escrow_submission(uuid,uuid,text,jsonb,boolean,text)', 'EXECUTE') AS authenticated,
  has_function_privilege('service_role', 'public.reconcile_escrow_submission(uuid,uuid,text,jsonb,boolean,text)', 'EXECUTE') AS service_role;
