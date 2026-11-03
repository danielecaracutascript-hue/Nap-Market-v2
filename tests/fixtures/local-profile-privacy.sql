-- Synthetic local fixtures only. Never run against the remote database.
DO $fixture$
BEGIN
 IF to_regclass('nap_integration.fixture_marker') IS NULL
 THEN RAISE EXCEPTION 'Local fixture required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='profiles' AND policyname='fixture_profiles')
 THEN ALTER POLICY fixture_profiles ON public.profiles RENAME TO "profiles readable"; END IF;
END;
$fixture$;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS handle text,ADD COLUMN IF NOT EXISTS country char(2),
 ADD COLUMN IF NOT EXISTS seller_type text,ADD COLUMN IF NOT EXISTS business_info jsonb;
