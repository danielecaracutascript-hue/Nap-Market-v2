-- Apply once in the SQL Editor as postgres. Does not call application functions or send BTC.
-- No existing orders, PSBTs or funded outpoints are modified or backfilled.
BEGIN;

CREATE TABLE public.escrow_submission_claims (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('release', 'refund')),
  txid text NOT NULL UNIQUE CHECK (txid ~ '^[0-9a-f]{64}$'),
  funding_txid text NOT NULL CHECK (funding_txid ~ '^[0-9a-f]{64}$'),
  funding_vout bigint NOT NULL CHECK (funding_vout BETWEEN 0 AND 4294967295),
  psbt_id text NOT NULL,
  claim_id uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'broadcast', 'reconciled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  UNIQUE (funding_txid, funding_vout)
);

ALTER TABLE public.escrow_submission_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.escrow_submission_claims FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.escrow_submission_claims FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.escrow_submission_claims TO service_role;
GRANT UPDATE (state, acknowledged_at) ON TABLE public.escrow_submission_claims TO service_role;
CREATE POLICY service_manages_submission_state ON public.escrow_submission_claims
  FOR ALL TO service_role, postgres USING (true) WITH CHECK (true);

CREATE FUNCTION public.claim_escrow_submission(
  p_order uuid, p_purpose text, p_txid text, p_funding_txid text,
  p_funding_vout bigint, p_psbt_id text, p_claim_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  c public.escrow_submission_claims%ROWTYPE;
BEGIN
  -- Serializes requests for this order, including opposite settlement purposes.
  SELECT * INTO o FROM public.orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;

  SELECT * INTO c FROM public.escrow_submission_claims WHERE order_id = p_order;
  IF FOUND THEN
    RETURN jsonb_build_object('acquired', false, 'order_id', c.order_id,
      'purpose', c.purpose, 'txid', c.txid, 'state', c.state, 'claim_id', c.claim_id);
  END IF;

  IF p_purpose IS NULL OR p_purpose NOT IN ('release', 'refund')
     OR (p_purpose = 'release' AND o.status IS DISTINCT FROM 'COMPLETED')
     OR (p_purpose = 'refund' AND o.status IS DISTINCT FROM 'REFUNDED')
     OR o.released_txid IS NOT NULL OR o.refunded_txid IS NOT NULL
  THEN RAISE EXCEPTION 'Order is not available for settlement'; END IF;

  IF p_txid IS NULL OR p_txid !~ '^[0-9a-f]{64}$'
     OR p_funding_txid IS NULL OR p_funding_txid !~ '^[0-9a-f]{64}$'
     OR p_funding_vout IS NULL OR p_funding_vout NOT BETWEEN 0 AND 4294967295
     OR p_claim_id IS NULL
     OR o.funding_txid IS NULL OR lower(o.funding_txid) <> p_funding_txid
     OR o.funding_vout IS DISTINCT FROM p_funding_vout
     OR o.escrow_descriptor IS NULL
  THEN RAISE EXCEPTION 'Invalid settlement metadata'; END IF;

  IF EXISTS (SELECT 1 FROM public.psbts WHERE order_id = p_order AND status IN ('broadcast', 'confirmed'))
  THEN RAISE EXCEPTION 'A previous broadcast requires reconciliation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.psbts WHERE id::text = p_psbt_id
      AND order_id = p_order AND purpose = p_purpose AND status IN ('draft', 'partial'))
  THEN RAISE EXCEPTION 'Prepared transaction not found'; END IF;

  -- The second uniqueness constraint also protects an outpoint reused by another order.
  INSERT INTO public.escrow_submission_claims
    (order_id, purpose, txid, funding_txid, funding_vout, psbt_id, claim_id)
  VALUES (p_order, p_purpose, p_txid, p_funding_txid, p_funding_vout, p_psbt_id, p_claim_id)
  RETURNING * INTO c;

  RETURN jsonb_build_object('acquired', true, 'order_id', c.order_id,
    'purpose', c.purpose, 'txid', c.txid, 'state', c.state, 'claim_id', c.claim_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_escrow_submission(uuid,text,text,text,bigint,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_escrow_submission(uuid,text,text,text,bigint,text,uuid)
  TO service_role;

DO $permissions$
BEGIN
  IF has_function_privilege('anon', 'public.claim_escrow_submission(uuid,text,text,text,bigint,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.claim_escrow_submission(uuid,text,text,text,bigint,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.claim_escrow_submission(uuid,text,text,text,bigint,text,uuid)', 'EXECUTE')
     OR has_table_privilege('anon', 'public.escrow_submission_claims', 'SELECT')
     OR has_table_privilege('authenticated', 'public.escrow_submission_claims', 'SELECT')
     OR NOT has_column_privilege('service_role', 'public.escrow_submission_claims', 'state', 'UPDATE')
     OR has_column_privilege('service_role', 'public.escrow_submission_claims', 'txid', 'UPDATE')
  THEN RAISE EXCEPTION 'Unexpected submission privileges; roll back this transaction'; END IF;
END;
$permissions$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Metadata only. Does not execute the claim function or read order rows.
SELECT to_regclass('public.escrow_submission_claims') AS claims_table,
  has_function_privilege('anon', 'public.claim_escrow_submission(uuid,text,text,text,bigint,text,uuid)', 'EXECUTE') AS anon,
  has_function_privilege('authenticated', 'public.claim_escrow_submission(uuid,text,text,text,bigint,text,uuid)', 'EXECUTE') AS authenticated,
  has_function_privilege('service_role', 'public.claim_escrow_submission(uuid,text,text,text,bigint,text,uuid)', 'EXECUTE') AS service_role,
  has_table_privilege('anon', 'public.escrow_submission_claims', 'SELECT') AS anon_reads_claims,
  has_table_privilege('authenticated', 'public.escrow_submission_claims', 'SELECT') AS authenticated_reads_claims;
