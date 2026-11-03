-- Minimal synthetic schema for an ephemeral local PostgreSQL cluster only.
CREATE ROLE postgres LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT CREATE ON SCHEMA public TO postgres;
CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT anon, authenticated, service_role, pg_read_all_stats, pg_read_all_settings TO postgres;

CREATE TABLE public.orders (
  id uuid PRIMARY KEY,
  status text NOT NULL,
  funding_txid text,
  funding_vout integer,
  escrow_descriptor text,
  escrow_address text NOT NULL DEFAULT 'synthetic-address',
  escrow_index integer NOT NULL DEFAULT 42,
  price_sats bigint NOT NULL DEFAULT 100000,
  buyer_commission_sats bigint NOT NULL DEFAULT 4000,
  seller_commission_sats bigint NOT NULL DEFAULT 4000,
  released_txid text,
  refunded_txid text
);
CREATE TABLE public.psbts (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id),
  purpose text NOT NULL,
  status text NOT NULL,
  psbt text NOT NULL DEFAULT 'synthetic-psbt'
);
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.psbts ENABLE ROW LEVEL SECURITY;

-- Exercise SECURITY DEFINER + FORCE RLS without relying on a superuser owner.
ALTER TABLE public.orders OWNER TO postgres;
ALTER TABLE public.psbts OWNER TO postgres;
