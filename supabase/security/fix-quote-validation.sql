-- Preserves existing 4% arithmetic. No rates, listings or orders are modified.
BEGIN;
CREATE OR REPLACE FUNCTION public.quote_order(p_listing uuid,p_dest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE
 l public.listings%ROWTYPE;v_rate numeric;v_ship integer;v_fee integer;
 v_price_sats numeric;v_fee_sats numeric;v_ship_sats numeric;
BEGIN
 IF p_dest IS NULL OR trim(p_dest) !~ '^[A-Za-z]{2}$'
 THEN RAISE EXCEPTION 'Destination must be a 2-letter country code'; END IF;
 SELECT * INTO l FROM public.listings WHERE id=p_listing AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION 'Listing not available'; END IF;
 SELECT btc_eur INTO v_rate FROM public.fx_rates ORDER BY fetched_at DESC LIMIT 1;
 IF v_rate IS NULL OR v_rate::text IN ('NaN','Infinity','-Infinity') OR v_rate<=0
 THEN RAISE EXCEPTION 'No valid positive exchange rate available'; END IF;
 SELECT min(price_eur_cents) INTO v_ship FROM public.shipping_rates
 WHERE from_country=l.ship_from_country AND to_country=upper(trim(p_dest)) AND package_size=l.package_size;
 IF v_ship IS NULL OR v_ship<0 THEN RAISE EXCEPTION 'Shipping is not available for this destination'; END IF;
 IF l.price_eur_cents IS NULL OR l.price_eur_cents<=0 THEN RAISE EXCEPTION 'Invalid listing price'; END IF;
 v_fee:=round(l.price_eur_cents*0.04);
 v_price_sats:=round(l.price_eur_cents::numeric*1000000/v_rate);
 v_fee_sats:=round(v_fee::numeric*1000000/v_rate);
 v_ship_sats:=round(v_ship::numeric*1000000/v_rate);
 IF v_price_sats<=0 OR v_fee_sats<0 OR v_ship_sats<0
 OR v_price_sats+v_fee_sats>9007199254740991 OR v_ship_sats>9007199254740991
 THEN RAISE EXCEPTION 'Quoted Bitcoin amounts require review'; END IF;
 RETURN jsonb_build_object('price_eur_cents',l.price_eur_cents,'buyer_fee_eur_cents',v_fee,
  'shipping_eur_cents',v_ship,'total_eur_cents',l.price_eur_cents::bigint+v_fee+v_ship,
  'btc_eur',v_rate,'price_sats',v_price_sats,'buyer_commission_sats',v_fee_sats,
  'seller_commission_sats',v_fee_sats,'shipping_sats',v_ship_sats);
END $function$;
REVOKE EXECUTE ON FUNCTION public.quote_order(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.quote_order(uuid,text) TO authenticated,service_role;
COMMIT;
SELECT p.proname AS function_name,p.proconfig AS settings,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS service_role
FROM pg_proc p WHERE p.oid='public.quote_order(uuid,text)'::regprocedure;
