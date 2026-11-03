import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Runs only through the guarded local Supabase runner, never with a database URL.
export async function runLocalLifecycle({admin,buyer,seller,stranger,orderId,sql,root,anonymous,runtime}){
 sql(fs.readFileSync(path.join(root,'tests/fixtures/local-supabase-lifecycle.sql'),'utf8'));
 for(const file of ['fix-confirm-delivery.sql','fix-shipping-inputs.sql'])sql(fs.readFileSync(path.join(root,'supabase/security',file),'utf8'));
 sql("NOTIFY pgrst, 'reload schema';");
 for(let attempt=0;attempt<30;attempt++){
  const result=await admin.from('orders').select('return_deadline').limit(1);
  if(!result.error)break;if(attempt===29)throw Error('Lifecycle schema cache unavailable');
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 const listingId=randomUUID();
 assert.equal((await admin.from('listings').insert({id:listingId,status:'reserved'})).error,null);
 assert.equal((await admin.from('orders').update({listing_id:listingId}).eq('id',orderId)).error,null);
 const snapshot=async id=>{
  const order=await admin.from('orders').select('*').eq('id',id).single();assert.equal(order.error,null);
  const events=await admin.from('order_events').select('*').eq('order_id',id);assert.equal(events.error,null);
  const listing=await admin.from('listings').select('*').eq('id',order.data.listing_id).single();assert.equal(listing.error,null);
  // Events have no stable sequence in the minimal fixture, so compare canonical rows.
  return {order:order.data,events:events.data.map(event=>JSON.stringify(event)).sort(),listing:listing.data};
 };
 let checks=0;
 const denied=async(client,name,args,code='P0001')=>{
  const before=await snapshot(args.p_order);const result=await client.rpc(name,args);
  assert.equal(result.error?.code,code);assert.deepEqual(await snapshot(args.p_order),before);checks++;
 };
 const success=async(client,name,args,status,event)=>{
  const before=await snapshot(args.p_order);const result=await client.rpc(name,args);assert.equal(result.error,null);
  const after=await snapshot(args.p_order);assert.equal(after.order.status,status);
  assert.equal(after.events.length,before.events.length+1);
  assert.ok(after.events.some(row=>JSON.parse(row).type===event));checks++;return after;
 };
 const shipArgs={p_order:orderId,p_carrier:'  Carrier  ',p_tracking:'  TRACK123  '};
 await denied(buyer.client,'mark_shipped',shipArgs);
 await denied(stranger.client,'mark_shipped',shipArgs);
 await denied(seller.client,'mark_shipped',{...shipArgs,p_carrier:null});
 await denied(seller.client,'mark_shipped',{...shipArgs,p_tracking:null});
 const shipped=await success(seller.client,'mark_shipped',shipArgs,'SHIPPED','shipped');
 assert.equal(shipped.order.carrier,'Carrier');assert.equal(shipped.order.tracking_number,'TRACK123');
 await denied(seller.client,'mark_shipped',shipArgs);
 await denied(seller.client,'confirm_delivery',{p_order:orderId});
 const delivered=await success(buyer.client,'confirm_delivery',{p_order:orderId},'DELIVERED','delivered');
 assert.equal(Date.parse(delivered.order.window_ends_at)-Date.parse(delivered.order.delivered_at),14*86400000);checks++;
 await denied(seller.client,'request_return',{p_order:orderId});
 await denied(stranger.client,'request_return',{p_order:orderId});
 const requested=await success(buyer.client,'request_return',{p_order:orderId},'RETURN_REQUESTED','return_requested');
 assert.equal(Date.parse(requested.order.return_deadline)-Date.parse(requested.order.return_requested_at),7*86400000);checks++;
 await denied(buyer.client,'request_return',{p_order:orderId});
 await denied(seller.client,'ship_return',{p_order:orderId,p_tracking:'RETURN123'});
 await denied(buyer.client,'ship_return',{p_order:orderId,p_tracking:null});
 await success(buyer.client,'ship_return',{p_order:orderId,p_tracking:'  RETURN123  '},'RETURN_SHIPPED','return_shipped');
 await denied(buyer.client,'confirm_return_received',{p_order:orderId});
 const refunded=await success(seller.client,'confirm_return_received',{p_order:orderId},'REFUNDED','return_received');
 assert.equal(refunded.listing.status,'active');assert.equal(refunded.order.funding_txid,'a'.repeat(64));checks++;
 await denied(seller.client,'confirm_return_received',{p_order:orderId});
 await denied(buyer.client,'confirm_receipt',{p_order:orderId});

 async function scenario(status,fields={}){
  const id=randomUUID(),listing=randomUUID();
  assert.equal((await admin.from('listings').insert({id:listing,status:'reserved'})).error,null);
  assert.equal((await admin.from('orders').insert({id,listing_id:listing,buyer_id:buyer.id,seller_id:seller.id,status,
   price_sats:100000,buyer_commission_sats:4000,shipping_sats:1000,escrow_index:43,
   expires_at:new Date(Date.now()+3600000).toISOString(),...fields})).error,null);
  return id;
 }
 const completedId=await scenario('DELIVERED',{window_ends_at:new Date(Date.now()+86400000).toISOString()});
 await denied(seller.client,'confirm_receipt',{p_order:completedId});
 const completed=await success(buyer.client,'confirm_receipt',{p_order:completedId},'COMPLETED','receipt_confirmed');
 assert.equal(completed.listing.status,'sold');checks++;
 await denied(buyer.client,'confirm_receipt',{p_order:completedId});
 for(const deadline of [null,'2000-01-01T00:00:00Z']){
  const deliveredId=await scenario('DELIVERED',{window_ends_at:deadline});
  await denied(buyer.client,'request_return',{p_order:deliveredId});
  const returnId=await scenario('RETURN_REQUESTED',{return_deadline:deadline});
  await denied(buyer.client,'ship_return',{p_order:returnId,p_tracking:'RETURN123'});
 }
 const raceId=await scenario('DELIVERED',{window_ends_at:new Date(Date.now()+86400000).toISOString()});
 const competing=await Promise.all([
  buyer.client.rpc('confirm_receipt',{p_order:raceId}),
  buyer.client.rpc('request_return',{p_order:raceId}),
 ]);
 assert.deepEqual(competing.map(result=>result.error?.code??'ok').sort(),['P0001','ok']);
 const raced=await snapshot(raceId);assert.equal(raced.events.length,1);
 assert.ok(['COMPLETED','RETURN_REQUESTED'].includes(raced.order.status));checks++;
 const repeatedId=await scenario('RETURN_SHIPPED');
 const repeated=await Promise.all([
  seller.client.rpc('confirm_return_received',{p_order:repeatedId}),
  seller.client.rpc('confirm_return_received',{p_order:repeatedId}),
 ]);
 assert.deepEqual(repeated.map(result=>result.error?.code??'ok').sort(),['P0001','ok']);
 const singleRefund=await snapshot(repeatedId);assert.equal(singleRefund.events.length,1);
 assert.equal(singleRefund.order.status,'REFUNDED');assert.equal(singleRefund.listing.status,'active');checks++;
 for(const [name,args] of [
  ['mark_shipped',shipArgs],['confirm_delivery',{p_order:orderId}],['request_return',{p_order:orderId}],
  ['ship_return',{p_order:orderId,p_tracking:'RETURN123'}],['confirm_return_received',{p_order:orderId}],['confirm_receipt',{p_order:orderId}],
 ])await denied(anonymous,name,args,'42501');
 fs.writeFileSync(path.join(runtime,'lifecycle-integration-report.json'),JSON.stringify({checks,real:['Auth','PostgREST','PostgreSQL','reviewed lifecycle functions'],syntheticOrderId:orderId,finalStatus:'REFUNDED',bitcoinOperations:0,schema:'minimal synthetic fixture'},null,2));
 console.log(`PASS: ${checks} real local Supabase lifecycle checks. Shipment/delivery/return/refund approval, roles, deadlines, duplicates and competing requests. Synthetic rows only; no Bitcoin operations.`);
}
