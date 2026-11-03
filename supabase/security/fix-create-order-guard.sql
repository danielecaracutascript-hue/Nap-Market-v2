-- Preserves price/fee calculations and existing rows. Adds a locked check for
-- preexisting non-cancelled/non-refunded orders before making a new reservation.
BEGIN;
CREATE OR REPLACE FUNCTION public.create_order(p_listing uuid,p_address uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE l public.listings%ROWTYPE;a public.addresses%ROWTYPE;q jsonb;v_id uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid())
 THEN RAISE EXCEPTION 'Create your profile first'; END IF;
 SELECT * INTO l FROM public.listings WHERE id=p_listing AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Listing not available'; END IF;
 IF l.seller_id=auth.uid() THEN RAISE EXCEPTION 'You cannot buy your own listing'; END IF;
 IF EXISTS(SELECT 1 FROM public.orders WHERE listing_id=l.id AND status NOT IN ('CANCELLED','REFUNDED'))
 THEN RAISE EXCEPTION 'This listing already has an order in progress; manual review required'; END IF;
 SELECT * INTO a FROM public.addresses WHERE id=p_address AND user_id=auth.uid();
 IF NOT FOUND THEN RAISE EXCEPTION 'Address not found'; END IF;
 q:=public.quote_order(p_listing,a.country);
 INSERT INTO public.orders(
  listing_id,buyer_id,seller_id,price_eur_cents,shipping_eur_cents,btc_eur_rate,
  price_sats,buyer_commission_sats,seller_commission_sats,shipping_sats,
  expires_at,address_id,dest_country,package_size
 ) VALUES(
  l.id,auth.uid(),l.seller_id,l.price_eur_cents,(q->>'shipping_eur_cents')::integer,(q->>'btc_eur')::numeric,
  (q->>'price_sats')::bigint,(q->>'buyer_commission_sats')::bigint,(q->>'seller_commission_sats')::bigint,
  (q->>'shipping_sats')::bigint,now()+interval '48 hours',a.id,a.country,l.package_size
 ) RETURNING id INTO v_id;
 UPDATE public.listings SET status='reserved' WHERE id=l.id;
 INSERT INTO public.order_events(order_id,actor_id,actor_role,type,data)
 VALUES(v_id,auth.uid(),'buyer','order_created',q);
 RETURN v_id;
END $function$;
REVOKE EXECUTE ON FUNCTION public.create_order(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_order(uuid,uuid) TO authenticated,service_role;
COMMIT;
SELECT p.proname AS function_name,p.proconfig AS settings,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS service_role
FROM pg_proc p WHERE p.oid='public.create_order(uuid,uuid)'::regprocedure;
