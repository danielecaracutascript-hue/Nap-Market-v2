import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ts=createRequire(path.join(root,'package.json'))('typescript');
const source=fs.readFileSync(path.join(root,'app/protected/orders/[id]/order-client.tsx'),'utf8')
 .replace('  if (!loaded) return','  return {createPayment,checkPayment};\n  if (!loaded) return');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017,jsx:ts.JsxEmit.ReactJSX}}).outputText;
async function run(options={}){
 const messages=[],busy=[],calls=[];let index=0;
 const order={id:'order',buyer_id:'buyer',seller_id:'seller',status:'CREATED'};
 const states=['buyer',order,[],[],true];states[15]=options.busy??false;
 const query={select(){return this},eq(){return this},order(){return this},limit(){return this},
  async maybeSingle(){return {data:order}},then(resolve){resolve({data:[]})}};
 const context={exports:{},process:{env:{}},fetch:async(url,request)=>{
  calls.push({url,request});if(options.networkError)throw Error('synthetic network failure');
  return {ok:options.ok??true,json:async()=>{if(options.invalidJson)throw Error('synthetic invalid JSON');return 'body' in options?options.body:{message:'Payment confirmed'}}};
 },require(name){
  if(name==='react')return {useRef:initial=>({current:initial}),useEffect(){},useState(initial){const i=index++;return [i in states?states[i]:initial,value=>{if(i===5)messages.push(value);if(i===15)busy.push(value)}]}};
  if(name==='react/jsx-runtime')return {};
  if(name==='next/link')return ()=>null;
  if(name==='@/lib/supabase/client')return {createClient:()=>({auth:{getUser:async()=>{
   if(options.reloadError)throw Error('synthetic reload failure');return {data:{user:{id:'buyer'}}};
  }},from:()=>query})};
  if(name==='@/lib/wallet')return new Proxy({},{get(){throw Error('Wallet access forbidden')}});
  if(name.startsWith('@/lib/'))return {};
  throw Error('Unexpected import '+name);
 }};
 vm.runInNewContext(code,context);
 await context.exports.default({orderId:'order'})[options.create?'createPayment':'checkPayment']();
 return {messages,busy,calls};
}
let count=0;
for(const options of [
 {},{create:true},{ok:false,body:{requiresReview:true,message:'Payment detected. Do not send another payment.'}},
 {ok:false,body:{error:'Payment details are not available'}},
 {networkError:true},{invalidJson:true},{body:null},{ok:false,body:{}},{reloadError:true},
]){
 const result=await run(options);assert.deepEqual(result.busy,[true,false]);assert.equal(result.calls.length,1);
 assert.equal(result.calls[0].request.method,'POST');
 assert.equal(result.calls[0].url,options.create?'/api/orders/order/escrow':'/api/orders/order/check-payment');
 const message=result.messages.at(-1);
 if(options.networkError||options.invalidJson||options.body===null||options.reloadError||options.ok===false&&!options.body?.message&&!options.body?.error){
  assert.match(message,/Do not send another payment/);
 }else if(options.body?.message){assert.equal(message,options.body.message)}
 else if(options.body?.error){assert.equal(message,options.body.error)}
 else assert.equal(message,'Payment confirmed');
 count++;
}
const blocked=await run({busy:true});assert.equal(blocked.calls.length,0);assert.equal(blocked.busy.length,0);count++;
console.log(`PASS: ${count} payment UI handler checks. Network/session are inert doubles; wallet access forbidden.`);
