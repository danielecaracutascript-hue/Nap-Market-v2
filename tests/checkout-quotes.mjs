import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ts=createRequire(path.join(root,'package.json'))('typescript');
const source=fs.readFileSync(path.join(root,'app/protected/listings/[id]/buy/buy-client.tsx'),'utf8')
 .replace('  const field =','  capture({createOrder,loadAddresses,saveAddress});\n  const field =');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const quote=n=>({price_eur_cents:n,buyer_fee_eur_cents:400,shipping_eur_cents:100,total_eur_cents:n+500,btc_eur:100000,price_sats:100000,buyer_commission_sats:4000,shipping_sats:1000});
function browser(options={}){
 const addresses=[{id:'it',country:'IT',full_text:'Synthetic address IT'},{id:'fr',country:'FR',full_text:'Synthetic address FR'}];
 const states=[addresses,'it','','',{listingId:'listing',addressId:'it',country:'IT',value:quote(1000)},'',options.busy??false];
 const requests=[],creates=[],navigations=[],pendingCreates=[],addressRequests=[];let index=0,refIndex=0,effects,handlers;
 const refs=[];
 const jsx=(type,props)=>({type,props});
 const context={exports:{},capture:value=>{handlers=value},require(name){
  if(name==='react')return {useRef(initial){const i=refIndex++;return refs[i]??(refs[i]={current:initial})},useState(initial){const i=index++;if(!(i in states))states[i]=initial;return [states[i],value=>{states[i]=value}]},useEffect(effect,deps){effects.push({effect,deps})}};
  if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};if(name==='next/link')return 'link';
  if(name==='next/navigation')return {useRouter:()=>({push(url){if(options.navigationError)throw Error('Synthetic navigation failure');navigations.push(url)}})};
  if(name==='@/lib/supabase/client')return {createClient:()=>({rpc(name,args){
   if(name==='my_addresses'||name==='save_address')return new Promise((resolve,reject)=>addressRequests.push({name,args,resolve,reject}));
   if(name==='create_order'){
    creates.push(args);if(options.creationThrows)return Promise.reject(Error('Synthetic network failure'));
    if(options.deferredCreation)return new Promise(resolve=>pendingCreates.push(resolve));
    return Promise.resolve({data:options.invalidResponse?null:'00000000-0000-4000-8000-000000000001',error:options.creationError??null});
   }
   assert.equal(name,'quote_order');
   return new Promise((resolve,reject)=>requests.push({args,resolve,reject}));
  }})};
  throw Error('Unexpected module '+name);
 }};
 vm.runInNewContext(code,context);
 function render(listingId='listing'){
  index=0;refIndex=0;effects=[];const tree=context.exports.default({listingId});return {tree,effects:[...effects]};
 }
 return {render,states,requests,creates,navigations,pendingCreates,addressRequests,get handlers(){return handlers}};
}
function nodes(tree,type){if(!tree||typeof tree!=='object')return [];if(Array.isArray(tree))return tree.flatMap(x=>nodes(x,type));return [...(tree.type===type?[tree]:[]),...nodes(tree.props?.children,type)]}
function text(tree){if(tree==null||typeof tree==='boolean')return '';if(typeof tree!=='object')return String(tree);if(Array.isArray(tree))return tree.map(text).join(' ');return text(tree.props?.children)}
const createButtons=tree=>nodes(tree,'button').filter(node=>/Create order|Creating\.\.\./.test(text(node)));
const settled=()=>new Promise(resolve=>setImmediate(resolve));let checks=0;
for(const oldError of [false,true]){
 const b=browser();let view=b.render();const oldCleanup=view.effects[1].effect();
 b.states[1]='fr';view=b.render();assert.equal(createButtons(view.tree).length,0);
 await b.handlers.createOrder();assert.equal(b.creates.length,0);checks++;
 oldCleanup();const newCleanup=view.effects[1].effect();assert.equal(b.requests.length,2);
 assert.equal(b.requests[1].args.p_dest,'FR');
 b.requests[1].resolve({data:quote(2000),error:null});await settled();
 view=b.render();assert.equal(createButtons(view.tree).length,1);assert.match(text(view.tree),/20\.00 EUR/);
 b.requests[0].resolve(oldError?{data:null,error:{message:'Old request error'}}:{data:quote(1000),error:null});await settled();
 view=b.render();assert.match(text(view.tree),/20\.00 EUR/);assert.doesNotMatch(text(view.tree),/Old request error/);checks++;
 assert.equal(createButtons(b.render('other-listing').tree).length,0);checks++;
 newCleanup();
}
for(const response of ['throws','error','empty']){
 const b=browser();let view=b.render();view.effects[1].effect();
 if(response==='throws')b.requests[0].reject(Error('Synthetic connection failure'));
 else b.requests[0].resolve(response==='error'?{data:null,error:{message:'Synthetic quote error'}}:{data:null,error:null});
 await settled();view=b.render();assert.equal(createButtons(view.tree).length,0);assert.ok(b.states[5]);
 await b.handlers.createOrder();assert.equal(b.creates.length,0);checks++;
}
const changed=browser();changed.states[0]=[{id:'it',country:'DE',full_text:'Changed synthetic country'}];
assert.equal(createButtons(changed.render().tree).length,0);checks++;
const busy=browser({busy:true});const busyView=busy.render();assert.equal(nodes(busyView.tree,'select')[0].props.disabled,true);
await busy.handlers.createOrder();assert.equal(busy.creates.length,0);checks++;
for(const options of [{creationThrows:true},{invalidResponse:true},{creationError:{code:'',message:'Network failure'}}]){
 const b=browser(options);b.render();await b.handlers.createOrder();let view=b.render();
 assert.equal(b.states[6],false);assert.match(text(view.tree),/Check My orders/);assert.equal(b.navigations.length,0);
 assert.equal(createButtons(view.tree)[0].props.disabled,true);
 await b.handlers.createOrder();assert.equal(b.creates.length,1);checks++;
}
const validation=browser({creationError:{code:'P0001',message:'Listing unavailable'}});validation.render();
await validation.handlers.createOrder();assert.equal(validation.states[6],false);assert.equal(validation.states[7],false);
assert.match(text(validation.render().tree),/Listing unavailable/);checks++;
const concurrent=browser({deferredCreation:true});concurrent.render();
const first=concurrent.handlers.createOrder();await concurrent.handlers.createOrder();assert.equal(concurrent.creates.length,1);
concurrent.pendingCreates[0]({data:'00000000-0000-4000-8000-000000000001',error:null});await first;
assert.equal(concurrent.navigations.length,1);checks++;
const navigation=browser({navigationError:true});navigation.render();await navigation.handlers.createOrder();
const known=navigation.render();assert.match(text(known.tree),/Open created order/);
assert.equal(navigation.states[8],'00000000-0000-4000-8000-000000000001');
await navigation.handlers.createOrder();assert.equal(navigation.creates.length,1);checks++;
for(const failure of ['throws','error']){
 const b=browser();b.render();const loading=b.handlers.loadAddresses();
 if(failure==='throws')b.addressRequests[0].reject(Error('Synthetic connection failure'));
 else b.addressRequests[0].resolve({data:null,error:{message:'Synthetic address error'}});
 await loading;
 assert.equal(b.states[0].length,0);assert.equal(b.states[1],'');assert.equal(b.states[4],null);
 assert.match(text(b.render().tree),/Addresses could not be loaded/);
 await b.handlers.createOrder();assert.equal(b.creates.length,0);checks++;
}
const saving=browser();saving.render();
const save=saving.handlers.saveAddress({preventDefault(){}});
await saving.handlers.saveAddress({preventDefault(){}});
await saving.handlers.createOrder();assert.equal(saving.addressRequests.length,1);assert.equal(saving.creates.length,0);
assert.equal(nodes(saving.render().tree,'select')[0].props.disabled,true);checks++;
saving.addressRequests[0].resolve({data:'fr',error:null});await settled();
assert.equal(saving.addressRequests[1].name,'my_addresses');
await saving.handlers.createOrder();assert.equal(saving.creates.length,0);
saving.addressRequests[1].resolve({data:[{id:'fr',country:'FR',full_text:'Synthetic address'}],error:null});await save;
assert.equal(saving.states[1],'fr');assert.equal(saving.states[9],false);
assert.equal(createButtons(saving.render().tree).length,0);checks++;
for(const failure of ['throws','error']){
 const b=browser();b.render();const pending=b.handlers.saveAddress({preventDefault(){}});
 if(failure==='throws')b.addressRequests[0].reject(Error('Synthetic connection failure'));
 else b.addressRequests[0].resolve({data:null,error:{message:'Synthetic validation error'}});
 await pending;assert.equal(b.states[9],false);assert.ok(b.states[5]);checks++;
}
const refreshing=browser();refreshing.render();const refresh=refreshing.handlers.loadAddresses('missing');
refreshing.addressRequests[0].resolve({data:[{id:'new',country:'IT',full_text:'Synthetic replacement'}],error:null});
await refresh;assert.equal(refreshing.states[1],'new');checks++;
for(const failed of [false,true]){
 const b=browser();b.render();const old=b.handlers.loadAddresses();const recent=b.handlers.loadAddresses('new');
 b.addressRequests[1].resolve({data:[{id:'new',country:'FR',full_text:'Synthetic new address'}],error:null});await recent;
 if(failed)b.addressRequests[0].reject(Error('Synthetic stale failure'));
 else b.addressRequests[0].resolve({data:[{id:'old',country:'IT',full_text:'Synthetic stale address'}],error:null});
 await old;assert.equal(b.states[1],'new');assert.equal(b.states[0][0].id,'new');checks++;
}
console.log(`PASS: ${checks} checkout quote/creation/address scenarios. Requests and navigation are inert doubles; no live orders or personal addresses.`);
