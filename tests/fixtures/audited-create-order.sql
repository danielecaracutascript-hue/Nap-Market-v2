-- Active create_order supplied in the audit. SYNTHETIC DATABASE TESTS ONLY.
CREATE OR REPLACE FUNCTION public.create_order(p_listing uuid, p_address uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  l listings%rowtype;
  a addresses%rowtype;
  q jsonb;
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'Create your profile first';
  end if;
  select * into l from listings where id = p_listing and status = 'active' for update;
  if not found then raise exception 'Listing not available'; end if;
  if l.seller_id = auth.uid() then raise exception 'You cannot buy your own listing'; end if;
  select * into a from addresses where id = p_address and user_id = auth.uid();
  if not found then raise exception 'Address not found'; end if;

  q := quote_order(p_listing, a.country);

  insert into orders (
    listing_id, buyer_id, seller_id, price_eur_cents, shipping_eur_cents, btc_eur_rate,
    price_sats, buyer_commission_sats, seller_commission_sats, shipping_sats,
    expires_at, address_id, dest_country, package_size
  ) values (
    l.id, auth.uid(), l.seller_id, l.price_eur_cents, (q->>'shipping_eur_cents')::integer, (q->>'btc_eur')::numeric,
    (q->>'price_sats')::bigint, (q->>'buyer_commission_sats')::bigint, (q->>'seller_commission_sats')::bigint,
    (q->>'shipping_sats')::bigint, now() + interval '48 hours', a.id, a.country, l.package_size
  ) returning id into v_id;

  update listings set status = 'reserved' where id = l.id;
  insert into order_events (order_id, actor_id, actor_role, type, data)
  values (v_id, auth.uid(), 'buyer', 'order_created', q);
  return v_id;
end $function$;
