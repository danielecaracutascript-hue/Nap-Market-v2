import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

// Real Next HTTP + local Auth/PostgREST. No browser rendering or Bitcoin calls.
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtime=path.join(path.dirname(app),'work/integration-local');
const metadata=JSON.parse(fs.readFileSync(path.join(runtime,'browser-preview.json'),'utf8'));
const origin='http://127.0.0.1:3100',api='http://127.0.0.1:54321';
assert.equal(metadata.url,origin+'/auth/integration-login');
assert.equal(metadata.signingDisabled,true);
assert.ok(path.resolve(metadata.preview).startsWith(runtime+path.sep+'browser-preview-'));
const dockerBin='C:\\Users\\Daniele\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin';
const status=spawnSync(path.join(runtime,'tools/node_modules/@supabase/cli-windows-x64/bin/supabase.exe'),
 ['status','--workdir',path.join(runtime,'stack'),'-o','json'],{encoding:'utf8',windowsHide:true,
 env:{...process.env,PATH:dockerBin+path.delimiter+process.env.PATH,DOCKER_HOST:'npipe:////./pipe/dockerDesktopLinuxEngine'}});
assert.equal(status.status,0,'Local stack status unavailable; output withheld');
const config=JSON.parse(status.stdout);assert.equal(config.API_URL,api);
const req=createRequire(path.join(app,'package.json'));
const {createServerClient}=req('@supabase/ssr');
let checks=0;
function check(value,message){assert.ok(value,message);checks++;}
async function login(role){
 const response=await fetch(metadata.url+(role==='seller'?'?as=seller':''),{redirect:'manual'});
 check(response.status===307,'Synthetic Next login must redirect');
 const location=new URL(response.headers.get('location'));
 check(location.origin===origin&&location.pathname===`/protected/listings/${metadata.listingId}/buy`,'Local checkout redirect');
 const cookies=new Map(response.headers.getSetCookie().map(value=>{
  const pair=value.split(';')[0],index=pair.indexOf('=');return [pair.slice(0,index),pair.slice(index+1)];
 }));
 check(cookies.size>0,'Next must set SSR session cookies');
 const client=createServerClient(api,config.PUBLISHABLE_KEY??config.ANON_KEY,{cookies:{
  getAll:()=>[...cookies].map(([name,value])=>({name,value})),
  setAll:values=>values.forEach(({name,value})=>cookies.set(name,value)),
 },global:{fetch:(url,options)=>{assert.equal(new URL(url).origin,api);return fetch(url,options)}}});
 const user=await client.auth.getUser();
 check(!user.error&&user.data.user.id===metadata[role+'Id'],'Next session accepted by real local Auth');
 const headers=()=>({cookie:[...cookies].map(([name,value])=>`${name}=${value}`).join('; ')});
 return {client,headers};
}
async function page(pathname,session,expected){
 const response=await fetch(origin+pathname,{headers:session.headers(),redirect:'manual'});
 const html=await response.text();
 check(response.status===200,'Authenticated Next page must return HTTP 200');
 check(html.includes(expected)&&!html.includes('NEXT_REDIRECT'),'Expected server-rendered page boundary');
}
const buyer=await login('buyer');
if(process.argv.includes('--profile-privacy')){
 await page(`/protected/listings/${metadata.listingId}`,buyer,'preview-seller');
 const own=await buyer.client.from('profiles').select('id,wallet_xpub');
 check(!own.error&&own.data.length===1&&own.data[0].id===metadata.buyerId,'Next synthetic buyer owns the only full profile visible');
 const seller=await buyer.client.from('public_profiles').select('id,handle').eq('id',metadata.sellerId).single();
 check(!seller.error&&seller.data.handle==='preview-seller','Public seller projection visible to buyer');
}
await page(`/protected/listings/${metadata.listingId}/buy`,buyer,'Checkout');
const addresses=await buyer.client.rpc('my_addresses');
check(!addresses.error&&addresses.data.length===1,'Synthetic buyer address through real PostgREST');
const existing=await buyer.client.from('orders').select('id').eq('listing_id',metadata.listingId);
check(!existing.error&&existing.data.length<=1,'At most one synthetic preview order');
let id=existing.data[0]?.id;
const creationPerformed=!id;
if(!id){
 const quote=await buyer.client.rpc('quote_order',{p_listing:metadata.listingId,p_dest:'IT'});
 check(!quote.error&&quote.data.total_eur_cents===11400,'Real quote retains price, buyer fee and shipping');
 const created=await buyer.client.rpc('create_order',{p_listing:metadata.listingId,p_address:addresses.data[0].id});
 check(!created.error&&typeof created.data==='string','Real PostgREST order creation');
 id=created.data;
}
const order=await buyer.client.from('orders').select('*').eq('id',id).single();
check(!order.error&&order.data.status==='CREATED'&&order.data.buyer_id===metadata.buyerId,'Created synthetic order owned by buyer');
for(const [table,columns] of [['order_events','type, actor_role, created_at, data'],['reviews','reviewer_id, rating, comment'],
 ['disputes','id, reason, description, status, decision, decision_notes, opened_by']]){
 const result=await buyer.client.from(table).select(columns).eq('order_id',id);
 check(!result.error,'Order client query supported: '+table);
 if(table==='order_events')check(result.data.length===1&&result.data[0].type==='order_created','One creation event');
}
await page('/protected/orders/'+id,buyer,id);
await page('/protected/orders',buyer,'Synthetic browser checkout');
const list=await buyer.client.from('orders').select('id,status,price_eur_cents,created_at,listings(title)').eq('id',id);
check(!list.error&&list.data.length===1&&list.data[0].listings.title==='Synthetic browser checkout','Actual orders list relation query');
const repeated=await buyer.client.rpc('create_order',{p_listing:metadata.listingId,p_address:addresses.data[0].id});
check(!!repeated.error,'Repeated creation blocked after reservation');
const seller=await login('seller');
const sellerOrder=await seller.client.from('orders').select('id,status').eq('id',id);
check(!sellerOrder.error&&sellerOrder.data.length===1,'Seller sees the same synthetic order');
for(const purpose of ['release','refund']){
 const response=await fetch(`${origin}/api/orders/${id}/${purpose}/submit`,{method:'POST',headers:buyer.headers()});
 check(response.status===503,'Preview broadcast endpoint disabled: '+purpose);
}
const report={checks,orderId:id,creationPerformed,nextHttp:true,realLocalAuthAndRest:true,browserRendering:false,bitcoinOperations:0};
fs.writeFileSync(path.join(runtime,'next-checkout-report.json'),JSON.stringify(report,null,2));
console.log(`${checks} local Next/HTTP checkout checks passed. Browser rendering not tested. No Bitcoin operations.`);
