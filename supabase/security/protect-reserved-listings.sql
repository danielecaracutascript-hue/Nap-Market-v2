-- Changes only the existing seller UPDATE policy. No listing/order rows change.
-- Owner/service business functions keep managing reserved/sold transitions.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='listings'
  AND policyname='seller updates listings' AND cmd='UPDATE')
 OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='listings'
  AND policyname<>'seller updates listings' AND cmd IN ('UPDATE','ALL'))
 OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.listings'::regclass)
 THEN RAISE EXCEPTION 'Unexpected listing policies; review before applying this patch'; END IF;
END $guard$;
ALTER POLICY "seller updates listings" ON public.listings
USING (
 seller_id=auth.uid() AND status IN ('draft','active','removed')
 AND NOT EXISTS(SELECT 1 FROM public.orders o WHERE o.listing_id=listings.id
   AND o.status NOT IN ('CANCELLED','REFUNDED'))
)
WITH CHECK (
 seller_id=auth.uid() AND status IN ('draft','active','removed')
 AND NOT EXISTS(SELECT 1 FROM public.orders o WHERE o.listing_id=listings.id
   AND o.status NOT IN ('CANCELLED','REFUNDED'))
);
COMMIT;
SELECT policyname AS policy_name,qual AS policy_using,with_check AS policy_check
FROM pg_policies WHERE schemaname='public' AND tablename='listings' AND policyname='seller updates listings';
