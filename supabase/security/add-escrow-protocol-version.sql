-- Schema-only preparation for a gradual Escrow V2 rollout.
-- Existing orders remain legacy_v1; descriptors, addresses, funding and PSBTs
-- are never rewritten. Run separately and only after a local validation.
BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.orders') IS NULL THEN
    RAISE EXCEPTION 'orders table is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.orders'::regclass
      AND attname = 'escrow_protocol' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'escrow_protocol already exists; inspect its definition before changing it';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.orders'::regclass
      AND conname = 'orders_escrow_protocol_check'
  ) THEN
    RAISE EXCEPTION 'orders_escrow_protocol_check already exists';
  END IF;
END
$guard$;

ALTER TABLE public.orders
  ADD COLUMN escrow_protocol text NOT NULL DEFAULT 'legacy_v1';

ALTER TABLE public.orders
  ADD CONSTRAINT orders_escrow_protocol_check
  CHECK (escrow_protocol IN ('legacy_v1', 'escrow_v2')) NOT VALID;

-- A constant default makes pre-existing rows read as legacy_v1. This guard
-- proves the migration did not create an unexpected protocol value.
DO $check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.orders
    WHERE escrow_protocol IS DISTINCT FROM 'legacy_v1'
  ) THEN
    RAISE EXCEPTION 'Unexpected existing escrow protocol; transaction rolled back';
  END IF;
END
$check$;

COMMIT;

-- Catalog-only confirmation; does not return order rows or values.
SELECT a.attname AS column_name,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
  a.attnotnull AS not_null,
  pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expression,
  c.conname AS constraint_name,
  pg_catalog.pg_get_constraintdef(c.oid) AS constraint_definition,
  c.convalidated AS constraint_validated
FROM pg_catalog.pg_attribute a
LEFT JOIN pg_catalog.pg_attrdef d
  ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN pg_catalog.pg_constraint c
  ON c.conrelid = a.attrelid AND c.conname = 'orders_escrow_protocol_check'
WHERE a.attrelid = 'public.orders'::regclass
  AND a.attname = 'escrow_protocol' AND NOT a.attisdropped;
