-- ONLY the marked local synthetic Supabase project. Never install remotely.
BEGIN;
DO $guard$ BEGIN
 IF to_regclass('nap_integration.fixture_marker') IS NULL THEN RAISE EXCEPTION 'Missing local fixture marker'; END IF;
END $guard$;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS handle text,
 ADD COLUMN IF NOT EXISTS country char(2),ADD COLUMN IF NOT EXISTS seller_type text,
 ADD COLUMN IF NOT EXISTS business_info jsonb;
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS seller_id uuid REFERENCES public.profiles(id),
 ADD COLUMN IF NOT EXISTS title text,ADD COLUMN IF NOT EXISTS description text,
 ADD COLUMN IF NOT EXISTS category text,ADD COLUMN IF NOT EXISTS condition text,
 ADD COLUMN IF NOT EXISTS price_eur_cents integer,ADD COLUMN IF NOT EXISTS package_size text,
 ADD COLUMN IF NOT EXISTS ship_from_country char(2),ADD COLUMN IF NOT EXISTS photos text[] DEFAULT '{}',
 ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS price_eur_cents integer,
 ADD COLUMN IF NOT EXISTS shipping_eur_cents integer,ADD COLUMN IF NOT EXISTS btc_eur_rate numeric(18,2),
 ADD COLUMN IF NOT EXISTS seller_commission_sats bigint,
 ADD COLUMN IF NOT EXISTS address_id uuid,ADD COLUMN IF NOT EXISTS dest_country char(2),
 ADD COLUMN IF NOT EXISTS package_size text,ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.order_events ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
CREATE SEQUENCE IF NOT EXISTS nap_integration.browser_escrow_index START 100000;
ALTER TABLE public.orders ALTER COLUMN id SET DEFAULT gen_random_uuid(),
 ALTER COLUMN status SET DEFAULT 'CREATED',
 ALTER COLUMN escrow_index SET DEFAULT nextval('nap_integration.browser_escrow_index');
CREATE TABLE IF NOT EXISTS public.addresses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES public.profiles(id),country char(2) NOT NULL,
 encrypted_payload bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),delete_after timestamptz);
ALTER TABLE public.addresses ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.addresses TO authenticated;
GRANT ALL ON public.addresses TO service_role;
DROP POLICY IF EXISTS fixture_own_addresses ON public.addresses;
CREATE POLICY fixture_own_addresses ON public.addresses FOR ALL USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
DROP POLICY IF EXISTS fixture_listing_read ON public.listings;
CREATE POLICY fixture_listing_read ON public.listings FOR SELECT USING(status='active' OR seller_id=auth.uid()
 OR EXISTS(SELECT 1 FROM public.orders o WHERE o.listing_id=listings.id AND (o.buyer_id=auth.uid() OR o.seller_id=auth.uid())));
GRANT SELECT ON public.listings TO authenticated;
DO $relations$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.orders'::regclass AND conname='fixture_orders_listing_fk')
 THEN ALTER TABLE public.orders ADD CONSTRAINT fixture_orders_listing_fk FOREIGN KEY(listing_id) REFERENCES public.listings(id); END IF;
END $relations$;
CREATE TABLE IF NOT EXISTS public.fx_rates(btc_eur numeric,fetched_at timestamptz);
CREATE TABLE IF NOT EXISTS public.shipping_rates(from_country char(2),to_country char(2),package_size text,price_eur_cents integer);
CREATE TABLE IF NOT EXISTS public.reviews(order_id uuid,reviewer_id uuid,rating integer,comment text);
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.reviews TO authenticated;
DROP POLICY IF EXISTS fixture_review_read ON public.reviews;
CREATE POLICY fixture_review_read ON public.reviews FOR SELECT USING(EXISTS(SELECT 1 FROM public.orders o
 WHERE o.id=reviews.order_id AND (o.buyer_id=auth.uid() OR o.seller_id=auth.uid())));
CREATE OR REPLACE FUNCTION public.my_addresses() RETURNS TABLE(id uuid,country character,full_text text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT a.id,a.country,convert_from(a.encrypted_payload,'UTF8') FROM public.addresses a
 WHERE a.user_id=auth.uid() ORDER BY a.created_at DESC;
$function$;
REVOKE ALL ON FUNCTION public.my_addresses() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.my_addresses() TO authenticated,service_role;
COMMIT;
