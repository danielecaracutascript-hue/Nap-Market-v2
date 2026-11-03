-- Function from user audit. Synthetic commercial-state tests only. No Bitcoin.
CREATE OR REPLACE FUNCTION public.finalize_order(p_order uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o orders%rowtype;
begin
  select * into o from orders
    where id = p_order and (buyer_id = auth.uid() or seller_id = auth.uid()) for update;
  if not found then return false; end if;
  if (o.status = 'DELIVERED' and o.window_ends_at <= now())
     or (o.status = 'RETURN_REQUESTED' and o.return_deadline <= now()) then
    update orders set status = 'COMPLETED', closed_at = now(), updated_at = now() where id = p_order;
    update listings set status = 'sold' where id = o.listing_id;
    insert into order_events (order_id, actor_id, actor_role, type, data)
    values (p_order, auth.uid(), 'system', 'auto_completed',
            jsonb_build_object('reason',
              case when o.status = 'DELIVERED' then 'window_expired' else 'return_not_shipped' end));
    return true;
  end if;
  return false;
end $function$;
