-- Reviewed against the supplied definitions. Does not change existing addresses
-- or their byte representation; existing test-only plaintext storage is retained.
BEGIN;
REVOKE TRUNCATE ON public.addresses FROM PUBLIC,anon,authenticated;
DO $check$ BEGIN
 IF has_table_privilege('anon','public.addresses','TRUNCATE')
 OR has_table_privilege('authenticated','public.addresses','TRUNCATE')
 THEN RAISE EXCEPTION 'Client TRUNCATE still inherited; transaction rolled back'; END IF;
END $check$;
CREATE OR REPLACE FUNCTION public.save_address(p_country text,p_text text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v_id uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid())
 THEN RAISE EXCEPTION 'Create your profile first (Profile page)'; END IF;
 IF p_country IS NULL OR trim(p_country) !~ '^[A-Za-z]{2}$'
 THEN RAISE EXCEPTION 'Country must be a 2-letter code'; END IF;
 IF p_text IS NULL OR char_length(trim(p_text)) < 5
 THEN RAISE EXCEPTION 'Address is too short'; END IF;
 INSERT INTO public.addresses(user_id,country,encrypted_payload)
 VALUES(auth.uid(),upper(trim(p_country)),convert_to(trim(p_text),'UTF8')) RETURNING id INTO v_id;
 RETURN v_id;
END $function$;
ALTER FUNCTION public.my_addresses() SET search_path=pg_catalog,public,pg_temp;
REVOKE EXECUTE ON FUNCTION public.save_address(text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_address(text,text) TO authenticated,service_role;
COMMIT;
SELECT p.proname AS function_name,p.proconfig AS settings,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS service_role,
 has_table_privilege('anon','public.addresses','TRUNCATE') AS anon_truncate,
 has_table_privilege('authenticated','public.addresses','TRUNCATE') AS authenticated_truncate,
 has_table_privilege('service_role','public.addresses','TRUNCATE') AS service_role_truncate
FROM pg_proc p WHERE p.oid IN ('public.save_address(text,text)'::regprocedure,'public.my_addresses()'::regprocedure)
ORDER BY p.proname;
