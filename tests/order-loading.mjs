import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ts=createRequire(path.join(root,'package.json'))('typescript');
const source=fs.readFileSync(path.join(root,'app/protected/orders/[id]/order-client.tsx'),'utf8')
 .replace('  if (!loaded) return','  capture({load,act,ship,shipReturn,openDispute,submitReview});\n  if (!loaded) return');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const receipt='The transaction was sent. Transaction '+'a'.repeat(64);
function browser(options={}){
 const states=[];states[5]=receipt;let index=0,refIndex=0,handlers,orderReads=0;
 const reads=[],calls=[];
 const refs=[],deferredOrders=[],effects=[];
 const order={id:'order',buyer_id:'buyer',seller_id:'seller',status:options.due?'DELIVERED':'REFUNDED',window_ends_at:'2000-01-01',
  price_sats:100000,buyer_commission_sats:4000,seller_commission_sats:4000,shipping_sats:1000,price_eur_cents:1000,shipping_eur_cents:100,
  ...options.orderOverrides};
 const jsx=(type,props)=>({type,props});
 const context={exports:{},capture:value=>{handlers=value},process:{env:{}},require(name){
  if(name==='react')return {useRef(initial){const i=refIndex++;return refs[i]??(refs[i]={current:initial})},useEffect(effect){effects.push(effect)},useState(initial){const i=index++;if(!(i in states))states[i]=initial;return [states[i],value=>{states[i]=value}]}};
  if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
  if(name==='next/link')return 'link';
  if(name==='@/lib/wallet')return new Proxy({},{get(){throw Error('Wallet access forbidden')}});
  if(name==='@/lib/supabase/client')return {createClient:()=>({auth:{getUser:async()=>{
   if(options.authThrows)throw Error('synthetic network error');
   return {data:{user:options.guest?null:{id:'buyer'}},error:options.authError?{}:null};
  }},from(table){
   reads.push(table);
   return {insert(){calls.push('review');return actionResult()},select(){return this},eq(){return this},order(){return this},limit(){return this},
    async maybeSingle(){
     if(options.throwTable===table)throw Error('synthetic query error');
     if(table==='orders')orderReads++;
     if(table==='orders'&&options.deferOrders)return new Promise((resolve,reject)=>deferredOrders.push({resolve,reject}));
     return {data:table==='orders'&&!options.missing?order:null,error:options.errorTable===table?{}:null};
    },then(resolve){resolve({data:[],error:options.errorTable===table?{}:null})},
   };
  },async rpc(name){
   calls.push(name);if(name!=='finalize_order')return actionResult();
   if(!options.finalizeError)order.status='COMPLETED';return {error:options.finalizeError?{}:null};
  }})};
  if(name.startsWith('@/lib/'))return {};
  throw Error('Unexpected module '+name);
 }};
 async function actionResult(){
  if(options.actionThrows)throw Error('Synthetic action network failure');
  if(options.deferredAction)return new Promise(resolve=>{options.resolveAction=resolve});
  return {error:options.actionError?{message:'Synthetic rejected action'}:null};
 }
 vm.runInNewContext(code,context);
 const render=()=>{index=0;refIndex=0;return context.exports.default({orderId:'order'})};
 render();return {render,load:()=>handlers.load(),reads,calls,states,deferredOrders,effects,get handlers(){return handlers},get orderReads(){return orderReads}};
}
function nodes(tree,type){if(!tree||typeof tree!=='object')return [];if(Array.isArray(tree))return tree.flatMap(x=>nodes(x,type));return [...(tree.type===type?[tree]:[]),...nodes(tree.props?.children,type)]}
function text(tree){if(tree==null||typeof tree==='boolean')return '';if(typeof tree!=='object')return String(tree);if(Array.isArray(tree))return tree.map(text).join(' ');return text(tree.props?.children)}
let count=0;
for(const options of [{guest:true},{authError:true},{authThrows:true},{throwTable:'orders'},
 {errorTable:'orders'},{errorTable:'order_events'},{errorTable:'reviews'},{errorTable:'disputes'},
 {due:true,finalizeError:true}]){
 const b=browser(options);assert.equal(await b.load(),false);const tree=b.render();
 assert.equal(nodes(tree,'form').length,0);assert.match(text(tree),/Try again/);
 assert.match(text(tree),new RegExp('a'.repeat(64)));assert.doesNotMatch(text(tree),/Order not found/);
 assert.ok(nodes(tree,'p').some(p=>p.props.role==='alert'));count++;
}
const missing=browser({missing:true});assert.equal(await missing.load(),true);
assert.match(text(missing.render()),/Order not found/);assert.deepEqual(missing.reads,['orders']);count++;
assert.match(text(missing.render()),new RegExp('a'.repeat(64)));
const due=browser({due:true});assert.equal(await due.load(),true);assert.equal(due.orderReads,2);
assert.deepEqual(due.calls,['finalize_order']);assert.match(text(due.render()),/Order completed/);count++;
const options={errorTable:'order_events'},retry=browser(options);await retry.load();
options.errorTable=null;assert.equal(await retry.load(),true);const retried=retry.render();
assert.equal(nodes(retried,'form').filter(form=>form.props.onSubmit.name==='claimRefund').length,1);
assert.match(text(retried),new RegExp('a'.repeat(64)));count++;
console.log(`PASS: ${count} isolated order-loading scenarios. Receipt preserved, no wallet access or live services.`);
let actionChecks=0;
for(const action of ['act','ship','shipReturn','openDispute','submitReview']){
 for(const failure of ['success','error','throws']){
  const options={actionError:failure==='error',actionThrows:failure==='throws'};
  const b=browser(options);await b.load();b.render();
  const input=action==='act'?'confirm_receipt':{preventDefault(){}};
  await b.handlers[action](input);
  assert.equal(b.calls.length,1);assert.equal(b.states[22],false);assert.equal(b.orderReads,2);
  if(failure==='throws')assert.match(b.states[5],/action could not be confirmed/);
  if(failure==='error')assert.match(b.states[5],/Synthetic rejected action/);
  actionChecks++;
 }
}
const actionOptions={deferredAction:true},concurrent=browser(actionOptions);await concurrent.load();concurrent.render();
const first=concurrent.handlers.act('confirm_receipt');
await concurrent.handlers.act('request_return');await concurrent.handlers.ship({preventDefault(){}});
assert.equal(concurrent.calls.length,1);assert.equal(concurrent.states[22],true);
assert.equal(nodes(concurrent.render(),'fieldset')[0].props.disabled,true);
actionOptions.resolveAction({error:null});await first;
assert.equal(concurrent.states[22],false);actionChecks++;
const failedOptions={actionThrows:true},failedReload=browser(failedOptions);await failedReload.load();failedReload.render();
failedOptions.errorTable='orders';await failedReload.handlers.act('confirm_receipt');
assert.equal(failedReload.states[22],false);assert.equal(nodes(failedReload.render(),'form').length,0);
assert.match(text(failedReload.render()),/Try again/);actionChecks++;
await failedReload.handlers.act('confirm_receipt');assert.equal(failedReload.calls.length,1);actionChecks++;
for(const busyIndex of [15,17,20]){
 const b=browser();await b.load();b.states[busyIndex]=true;b.render();
 await b.handlers.act('confirm_receipt');assert.equal(b.calls.length,0);actionChecks++;
}
console.log(`PASS: ${actionChecks} order-action scenarios. RPCs and reviews are inert doubles; wallet access forbidden.`);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
let races=0;
for(const oldResult of ['success','error','missing','due']){
 const b=browser({deferOrders:true});
 const older=b.load();await tick();const newer=b.load();await tick();
 b.deferredOrders[1].resolve({data:{id:'order',status:'REFUNDED',buyer_id:'buyer',seller_id:'seller'},error:null});
 assert.equal(await newer,true);
 if(oldResult==='error')b.deferredOrders[0].reject(Error('Synthetic old connection failure'));
 else b.deferredOrders[0].resolve({data:oldResult==='missing'?null:{id:'order',status:oldResult==='due'?'DELIVERED':'SHIPPED',window_ends_at:'2000-01-01'},error:null});
 assert.equal(await older,false);assert.equal(b.states[1].status,'REFUNDED');assert.equal(b.states[21],'');
 assert.equal(b.states[4],true);assert.equal(b.calls.length,0);races++;
}
const loading=browser({deferOrders:true});const early=loading.load();await tick();const late=loading.load();await tick();
loading.deferredOrders[0].resolve({data:null,error:null});await early;
assert.equal(loading.states[4],false);assert.equal(loading.states[1],null);
loading.deferredOrders[1].resolve({data:null,error:null});await late;assert.equal(loading.states[4],true);races++;
const unmounted=browser({deferOrders:true});const cleanup=unmounted.effects[0]();await tick();cleanup();
unmounted.deferredOrders[0].resolve({data:{status:'DELIVERED',window_ends_at:'2000-01-01'},error:null});await tick();
assert.equal(unmounted.states[1],null);assert.equal(unmounted.states[4],false);assert.equal(unmounted.calls.length,0);races++;
console.log(`PASS: ${races} overlapping order-load scenarios. Delayed snapshots cannot replace newer results or trigger stale finalization.`);
let cancellationChecks=0;
for(const [column,value] of [['escrow_address','synthetic-address'],['escrow_descriptor','synthetic-descriptor'],
 ['shipping_address','synthetic-shipping'],['funding_txid','synthetic-txid'],['funding_vout',0],['escrow_address','']]){
 const b=browser({orderOverrides:{status:'CREATED',[column]:value}});await b.load();
 const tree=b.render();assert.equal(nodes(tree,'button').filter(button=>text(button)==='Cancel order').length,0);
 assert.match(text(tree),/manual review is required/);cancellationChecks++;
}
const cancellable=browser({orderOverrides:{status:'CREATED'}});await cancellable.load();
assert.equal(nodes(cancellable.render(),'button').filter(button=>text(button)==='Cancel order').length,1);cancellationChecks++;
console.log(`PASS: ${cancellationChecks} cancellation UI checks. No writes, wallet or live services.`);
