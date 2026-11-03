-- Active function supplied in checkout audit. Synthetic database tests only.
CREATE OR REPLACE FUNCTION public.cancel_order(p_order uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o orders%rowtype;
begin
  select * into o from orders
    where id = p_order and buyer_id = auth.uid() and status = 'CREATED' for update;
  if not found then raise exception 'Order cannot be cancelled'; end if;
  update orders set status = 'CANCELLED', closed_at = now(), updated_at = now() where id = p_order;
  update listings set status = 'active' where id = o.listing_id;
  insert into order_events (order_id, actor_id, actor_role, type, data)
  values (p_order, auth.uid(), 'buyer', 'order_cancelled', '{}');
end $function$;
