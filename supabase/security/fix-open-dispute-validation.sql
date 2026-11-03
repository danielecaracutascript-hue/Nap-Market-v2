-- Reviewed against the active definition supplied on 2026-10-30.
-- Installation does not open disputes or change existing order rows.
BEGIN;

CREATE OR REPLACE FUNCTION public.open_dispute(p_order uuid, p_reason text, p_description text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  v_role text;
  v_arb uuid;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('not_as_described','damaged','missing','not_delivered','other') THEN
    RAISE EXCEPTION 'Invalid reason';
  END IF;
  IF p_description IS NULL OR char_length(trim(p_description)) < 10 THEN
    RAISE EXCEPTION 'Please describe the problem (at least 10 characters)';
  END IF;

  SELECT * INTO o FROM public.orders
    WHERE id = p_order AND (buyer_id = auth.uid() OR seller_id = auth.uid()) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  v_role := CASE WHEN o.buyer_id = auth.uid() THEN 'buyer' ELSE 'seller' END;

  -- NULL status/deadline is not evidence that opening a dispute is allowed.
  IF (
    (v_role = 'buyer' AND o.status = 'DELIVERED' AND o.window_ends_at > now())
    OR (v_role = 'seller' AND o.status = 'RETURN_SHIPPED')
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'A dispute cannot be opened now (wrong status, or the 14-day window is over)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.disputes WHERE order_id = p_order AND status <> 'decided') THEN
    RAISE EXCEPTION 'A dispute is already open for this order';
  END IF;

  SELECT a.user_id INTO v_arb FROM public.arbiters a
    WHERE a.active AND a.user_id <> o.buyer_id AND a.user_id <> o.seller_id
    ORDER BY a.last_assigned_at ASC, a.user_id
    LIMIT 1 FOR UPDATE SKIP LOCKED;

  INSERT INTO public.disputes (order_id, opened_by, reason, description, arbiter_id, status)
  VALUES (p_order, auth.uid(), p_reason, trim(p_description), v_arb,
    CASE WHEN v_arb IS NULL THEN 'open' ELSE 'assigned' END)
  RETURNING id INTO v_id;

  IF v_arb IS NOT NULL THEN
    UPDATE public.arbiters SET last_assigned_at = now() WHERE user_id = v_arb;
  END IF;
  UPDATE public.orders SET status = 'DISPUTED', updated_at = now() WHERE id = p_order;
  INSERT INTO public.order_events (order_id, actor_id, actor_role, type, data)
  VALUES (p_order, auth.uid(), v_role, 'dispute_opened',
    jsonb_build_object('reason', p_reason, 'arbiter_assigned', v_arb IS NOT NULL));
  RETURN v_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.open_dispute(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_dispute(uuid, text, text) TO authenticated, service_role;

COMMIT;

SELECT p.proname AS function_name, p.proconfig AS settings,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
FROM pg_proc p WHERE p.oid = 'public.open_dispute(uuid,text,text)'::regprocedure;
