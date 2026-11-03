-- ONLY the marked synthetic local Supabase project; never install remotely.
BEGIN;
DO $guard$ BEGIN
 IF to_regclass('nap_integration.fixture_marker') IS NULL
 THEN RAISE EXCEPTION 'Local integration marker missing'; END IF;
END $guard$;
CREATE TABLE IF NOT EXISTS public.arbiters(
 user_id uuid PRIMARY KEY,active boolean NOT NULL DEFAULT true,languages text[],
 last_assigned_at timestamptz,cases_decided integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS public.disputes(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL,
 opened_by uuid,reason text,description text,arbiter_id uuid,status text,
 decision text,decision_notes text,opened_at timestamptz DEFAULT now(),decided_at timestamptz,
 fee_eur_cents integer DEFAULT 500
);
ALTER TABLE public.arbiters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.arbiters,public.disputes FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.arbiters,public.disputes TO anon,authenticated;
GRANT ALL ON public.arbiters,public.disputes TO service_role;
-- Same assigned-arbiter helper and read conditions supplied by the active audit.
CREATE OR REPLACE FUNCTION public.is_arbiter_of_order(p_order uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $function$
 SELECT EXISTS(SELECT 1 FROM disputes WHERE order_id=p_order AND arbiter_id=auth.uid());
$function$;
DROP POLICY IF EXISTS fixture_arbiter_orders ON public.orders;
CREATE POLICY fixture_arbiter_orders ON public.orders FOR SELECT USING(is_arbiter_of_order(id));
DROP POLICY IF EXISTS fixture_arbiter_events ON public.order_events;
CREATE POLICY fixture_arbiter_events ON public.order_events FOR SELECT USING(is_arbiter_of_order(order_id));
DROP POLICY IF EXISTS fixture_dispute_read ON public.disputes;
CREATE POLICY fixture_dispute_read ON public.disputes FOR SELECT USING(
 arbiter_id=auth.uid() OR EXISTS(SELECT 1 FROM orders o WHERE o.id=disputes.order_id
 AND (o.buyer_id=auth.uid() OR o.seller_id=auth.uid()))
);
COMMIT;
