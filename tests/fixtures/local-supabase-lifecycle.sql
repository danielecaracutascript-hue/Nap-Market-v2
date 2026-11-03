-- ONLY the marked synthetic local Supabase database. Never install remotely.
BEGIN;
DO $guard$ BEGIN
 IF to_regclass('nap_integration.fixture_marker') IS NULL
 THEN RAISE EXCEPTION 'Local integration fixture marker missing'; END IF;
END $guard$;
CREATE TABLE IF NOT EXISTS public.listings(id uuid PRIMARY KEY,status text NOT NULL);
ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.listings TO service_role;
ALTER TABLE public.orders
 ADD COLUMN IF NOT EXISTS listing_id uuid,
 ADD COLUMN IF NOT EXISTS carrier text,
 ADD COLUMN IF NOT EXISTS tracking_number text,
 ADD COLUMN IF NOT EXISTS shipped_at timestamptz,
 ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
 ADD COLUMN IF NOT EXISTS window_ends_at timestamptz,
 ADD COLUMN IF NOT EXISTS return_requested_at timestamptz,
 ADD COLUMN IF NOT EXISTS return_deadline timestamptz,
 ADD COLUMN IF NOT EXISTS return_tracking_number text,
 ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE public.order_events ADD COLUMN IF NOT EXISTS actor_id uuid;
-- Exact supplied business behavior; security settings applied by reviewed patch.
CREATE OR REPLACE FUNCTION public.confirm_receipt(p_order uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE o public.orders%ROWTYPE;
BEGIN
 SELECT * INTO o FROM orders WHERE id=p_order AND buyer_id=auth.uid() AND status='DELIVERED' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order cannot be confirmed (wrong status, or not your order)'; END IF;
 UPDATE orders SET status='COMPLETED',closed_at=now(),updated_at=now() WHERE id=p_order;
 UPDATE listings SET status='sold' WHERE id=o.listing_id;
 INSERT INTO order_events(order_id,actor_id,actor_role,type,data)
 VALUES(p_order,auth.uid(),'buyer','receipt_confirmed','{}');
END $function$;
CREATE OR REPLACE FUNCTION public.request_return(p_order uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE o public.orders%ROWTYPE;
BEGIN
 SELECT * INTO o FROM orders WHERE id=p_order AND buyer_id=auth.uid() AND status='DELIVERED'
 AND window_ends_at>now() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Return cannot be requested (wrong status, or the 14-day window is over)'; END IF;
 UPDATE orders SET status='RETURN_REQUESTED',return_requested_at=now(),
 return_deadline=now()+interval '7 days',updated_at=now() WHERE id=p_order;
 INSERT INTO order_events(order_id,actor_id,actor_role,type,data)
 VALUES(p_order,auth.uid(),'buyer','return_requested','{}');
END $function$;
CREATE OR REPLACE FUNCTION public.confirm_return_received(p_order uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE o public.orders%ROWTYPE;
BEGIN
 SELECT * INTO o FROM orders WHERE id=p_order AND seller_id=auth.uid() AND status='RETURN_SHIPPED' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Return cannot be confirmed (wrong status, or not your order)'; END IF;
 UPDATE orders SET status='REFUNDED',closed_at=now(),updated_at=now() WHERE id=p_order;
 UPDATE listings SET status='active' WHERE id=o.listing_id;
 INSERT INTO order_events(order_id,actor_id,actor_role,type,data)
 VALUES(p_order,auth.uid(),'seller','return_received','{}');
END $function$;
REVOKE ALL ON FUNCTION public.confirm_receipt(uuid),public.request_return(uuid),public.confirm_return_received(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.confirm_receipt(uuid),public.request_return(uuid),public.confirm_return_received(uuid) TO authenticated,service_role;
COMMIT;
