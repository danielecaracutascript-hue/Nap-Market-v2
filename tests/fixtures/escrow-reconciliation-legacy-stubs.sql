-- Test doubles for legacy settlement functions. NEVER install in Supabase.
-- Loaded only by the runner into its freshly created localhost cluster.
ALTER TABLE public.psbts ADD COLUMN txid text;
ALTER TABLE public.psbts ADD COLUMN signed_by text[] NOT NULL DEFAULT ARRAY[]::text[];
CREATE TABLE public.settlement_test_events(order_id uuid, purpose text, txid text);
CREATE TABLE public.settlement_test_failures(order_id uuid PRIMARY KEY, stage text NOT NULL);
ALTER TABLE public.settlement_test_events OWNER TO postgres;
ALTER TABLE public.settlement_test_failures OWNER TO postgres;

CREATE FUNCTION public.mark_order_released(p_order uuid, p_txid text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.settlement_test_failures WHERE order_id=p_order AND stage='noop') THEN RETURN; END IF;
  UPDATE public.orders SET released_txid=p_txid WHERE id=p_order AND status='COMPLETED' AND released_txid IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Test order cannot be released'; END IF;
  INSERT INTO public.settlement_test_events VALUES(p_order,'release',p_txid);
  IF EXISTS (SELECT 1 FROM public.settlement_test_failures WHERE order_id=p_order AND stage='legacy') THEN RAISE EXCEPTION 'Injected legacy error'; END IF;
END;
$function$;
CREATE FUNCTION public.mark_order_refunded(p_order uuid, p_txid text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  UPDATE public.orders SET refunded_txid=p_txid WHERE id=p_order AND status='REFUNDED' AND refunded_txid IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Test order cannot be refunded'; END IF;
  INSERT INTO public.settlement_test_events VALUES(p_order,'refund',p_txid);
END;
$function$;
CREATE FUNCTION public.test_fail_psbt_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.settlement_test_failures WHERE order_id=NEW.order_id AND stage='psbt') THEN RAISE EXCEPTION 'Injected PSBT update error'; END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.mark_order_released(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.mark_order_refunded(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.test_fail_psbt_update() OWNER TO postgres;
CREATE TRIGGER test_fail_psbt_update BEFORE UPDATE ON public.psbts FOR EACH ROW EXECUTE FUNCTION public.test_fail_psbt_update();
REVOKE EXECUTE ON FUNCTION public.mark_order_released(uuid,text), public.mark_order_refunded(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_order_released(uuid,text), public.mark_order_refunded(uuid,text) TO service_role;
