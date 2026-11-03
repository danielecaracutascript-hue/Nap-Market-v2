-- Reviewed against the active definition supplied on 2026-10-30.
-- Installation changes function code only; it does not decide any dispute.
BEGIN;

CREATE OR REPLACE FUNCTION public.decide_dispute(p_dispute uuid, p_decision text, p_notes text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  d public.disputes%ROWTYPE;
  o public.orders%ROWTYPE;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('seller', 'buyer') THEN
    RAISE EXCEPTION 'Decision must be seller or buyer';
  END IF;
  IF p_notes IS NULL OR char_length(trim(p_notes)) < 10 THEN
    RAISE EXCEPTION 'Please explain your decision (at least 10 characters)';
  END IF;

  SELECT * INTO d FROM public.disputes
    WHERE id = p_dispute AND arbiter_id = auth.uid() AND status = 'assigned' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dispute not found, not assigned to you, or already decided';
  END IF;

  SELECT * INTO o FROM public.orders WHERE id = d.order_id AND status = 'DISPUTED' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order is not in dispute'; END IF;

  UPDATE public.disputes
    SET status = 'decided', decision = p_decision, decision_notes = trim(p_notes), decided_at = now()
    WHERE id = p_dispute;

  IF p_decision = 'seller' THEN
    UPDATE public.orders SET status = 'COMPLETED', closed_at = now(), updated_at = now() WHERE id = o.id;
    UPDATE public.listings SET status = 'sold' WHERE id = o.listing_id;
  ELSE
    UPDATE public.orders SET status = 'REFUNDED', closed_at = now(), updated_at = now() WHERE id = o.id;
    UPDATE public.listings SET status = 'active' WHERE id = o.listing_id;
  END IF;

  UPDATE public.arbiters SET cases_decided = cases_decided + 1 WHERE user_id = auth.uid();
  INSERT INTO public.order_events (order_id, actor_id, actor_role, type, data)
  VALUES (o.id, auth.uid(), 'arbiter', 'dispute_decided',
    jsonb_build_object('decision', p_decision, 'fee_eur_cents', d.fee_eur_cents,
      'fee_paid_by', CASE WHEN p_decision = 'seller' THEN 'buyer' ELSE 'seller' END));
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.decide_dispute(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_dispute(uuid, text, text) TO authenticated, service_role;

COMMIT;

SELECT p.proname AS function_name, p.proconfig AS settings,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
FROM pg_proc p WHERE p.oid = 'public.decide_dispute(uuid,text,text)'::regprocedure;
