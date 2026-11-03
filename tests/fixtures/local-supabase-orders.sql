-- ONLY the dedicated disposable local Supabase project. Never install remotely.
-- The runner verifies the exact container/project/bindings before applying this.
BEGIN;
DO $guard$ BEGIN
 IF to_regclass('public.orders') IS NOT NULL
    AND to_regclass('nap_integration.fixture_marker') IS NULL
 THEN RAISE EXCEPTION 'Refusing a database with preexisting application orders'; END IF;
END $guard$;
CREATE SCHEMA IF NOT EXISTS nap_integration;
CREATE TABLE IF NOT EXISTS nap_integration.fixture_marker(id text PRIMARY KEY CHECK(id='nap-market-isolated-20261030'));
INSERT INTO nap_integration.fixture_marker VALUES('nap-market-isolated-20261030') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.profiles(id uuid PRIMARY KEY,wallet_xpub text);
CREATE TABLE IF NOT EXISTS public.orders(
 id uuid PRIMARY KEY,buyer_id uuid NOT NULL,seller_id uuid NOT NULL,status text NOT NULL,
 price_sats bigint NOT NULL,buyer_commission_sats bigint NOT NULL,shipping_sats bigint NOT NULL,
 escrow_descriptor text,escrow_index integer NOT NULL,escrow_address text,shipping_address text,
 expires_at timestamptz NOT NULL,funding_txid text,funding_vout integer,funding_height integer,
 funded_at timestamptz,updated_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.order_events(
 order_id uuid,actor_role text,type text,data jsonb
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fixture_profiles ON public.profiles;
CREATE POLICY fixture_profiles ON public.profiles FOR SELECT TO authenticated USING(true);
DROP POLICY IF EXISTS fixture_participants ON public.orders;
CREATE POLICY fixture_participants ON public.orders FOR SELECT TO authenticated
 USING(buyer_id=auth.uid() OR seller_id=auth.uid());
DROP POLICY IF EXISTS fixture_events ON public.order_events;
CREATE POLICY fixture_events ON public.order_events FOR SELECT TO authenticated USING(
 EXISTS(SELECT 1 FROM public.orders o WHERE o.id=order_id AND (o.buyer_id=auth.uid() OR o.seller_id=auth.uid()))
);
REVOKE ALL ON public.profiles,public.orders,public.order_events FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.profiles,public.orders,public.order_events TO authenticated;
GRANT ALL ON public.profiles,public.orders,public.order_events TO service_role;

-- Reviewed legacy definitions on synthetic tables only.
CREATE OR REPLACE FUNCTION public.set_order_escrow(p_order uuid,p_descriptor text,p_address text,p_shipping_address text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 UPDATE orders SET escrow_descriptor=p_descriptor,escrow_address=p_address,
 shipping_address=p_shipping_address,updated_at=now()
 WHERE id=p_order AND status='CREATED' AND escrow_address IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Escrow already set, or order not payable'; END IF;
 INSERT INTO order_events VALUES(p_order,'platform','escrow_created',jsonb_build_object('address',p_address));
END $function$;
CREATE OR REPLACE FUNCTION public.mark_order_funded(p_order uuid,p_txid text,p_vout integer,p_height integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 UPDATE orders SET status='FUNDED',funded_at=now(),funding_txid=p_txid,
 funding_vout=p_vout,funding_height=p_height,updated_at=now()
 WHERE id=p_order AND status='CREATED';
 IF NOT FOUND THEN RAISE EXCEPTION 'Order is not waiting for payment'; END IF;
 INSERT INTO order_events VALUES(p_order,'platform','payment_confirmed',
 jsonb_build_object('txid',p_txid,'vout',p_vout,'height',p_height));
END $function$;
REVOKE ALL ON FUNCTION public.set_order_escrow(uuid,text,text,text),public.mark_order_funded(uuid,text,integer,integer)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_order_escrow(uuid,text,text,text),public.mark_order_funded(uuid,text,integer,integer)
 TO service_role;
COMMIT;
