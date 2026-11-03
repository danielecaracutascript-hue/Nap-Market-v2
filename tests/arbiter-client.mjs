import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ts=createRequire(path.join(root,'package.json'))('typescript');
// Render the real component into a plain JSX tree with deterministic hook state.
// No browser, real users, credentials or service connections are involved.
async function browser(options={}){
 const states=[],rpcCalls=[];let cursor=0,handlers;
 const dispute={id:'dispute',reason:'other',description:'test description',status:'assigned',arbiter_id:'arbiter',opened_at:'2026-01-01',
  orders:{id:'order',buyer_id:'buyer',seller_id:'seller',price_eur_cents:1000,listings:{title:'Test listing'}}};
 const client={auth:{getUser:async()=>({data:{user:options.guest?null:{id:options.user??'arbiter'}}})},
  from(table){return {
   select(columns){assert.ok(!columns.includes('email'),'Unknown profile column must not be requested');return this},
   eq(){return this},in(){return this},order(){return this},
   async maybeSingle(){return {data:options.missing?null:dispute,error:options.disputeError?{message:'synthetic read error'}:null}},
   then(resolve){resolve({data:table==='public_profiles'?[{id:'buyer',handle:'buyer-handle'},{id:'seller',handle:'seller-handle'}]:[],
    error:options.errorTable===table?{message:'synthetic read error'}:null})},
  }},
  async rpc(name,args){rpcCalls.push({name,args});return {error:options.rpcError?{message:'Decision rejected'}:null}},
 };
 const source=fs.readFileSync(path.join(root,'app/protected/arbiter/[id]/arbiter-client.tsx'),'utf8')
  .replace('  if (!loaded) return','  capture({load, submitDecision});\n  if (!loaded) return');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const jsx=(type,props)=>({type,props});
 const context={exports:{},capture:value=>{handlers=value},require(name){
  if(name==='react')return {useEffect(){},useState(initial){const i=cursor++;if(!(i in states))states[i]=initial;return [states[i],value=>{states[i]=value}]}};
  if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
  if(name==='next/link')return 'link';
  if(name==='@/lib/supabase/client')return {createClient:()=>client};
  throw Error('Unexpected module '+name);
 }};
 vm.runInNewContext(code,context);
 const render=()=>{cursor=0;return context.exports.default({disputeId:'dispute'})};
 render();await handlers.load();
 return {render,get handlers(){return handlers},rpcCalls};
}
function nodes(tree,type){
 if(!tree||typeof tree!=='object')return [];
 if(Array.isArray(tree))return tree.flatMap(child=>nodes(child,type));
 return [...(tree.type===type?[tree]:[]),...nodes(tree.props?.children,type)];
}
const text=tree=>JSON.stringify(tree);
let count=0;
for(const options of [{guest:true},{disputeError:true},{errorTable:'public_profiles'},{errorTable:'order_events'}]){
 const b=await browser(options),tree=b.render();
 assert.equal(nodes(tree,'form').length,0);assert.equal(nodes(tree,'button').length,1);
 assert.match(text(tree),/alert/);assert.doesNotMatch(text(tree),/Loading\.\.\./);count++;
}
const missing=await browser({missing:true});assert.match(text(missing.render()),/Dispute not found/);count++;
for(const user of ['buyer','seller','other']){
 const b=await browser({user}),tree=b.render();assert.equal(nodes(tree,'form').length,0);
 await b.handlers.submitDecision({preventDefault(){}});assert.equal(b.rpcCalls.length,0);count++;
}
for(const [decision,notes] of [['buyer','short'],['','a valid explanation'],['buyer','          '],['buyer','  a valid explanation  ']]){
 const b=await browser();let tree=b.render();
 assert.match(text(tree),/buyer-handle/);assert.match(text(tree),/seller-handle/);
 assert.equal(nodes(tree,'form').length,1);
 const textarea=nodes(tree,'textarea')[0];assert.equal(textarea.props.required,true);assert.equal(textarea.props.minLength,10);
 textarea.props.onChange({target:{value:notes}});nodes(tree,'select')[0].props.onChange({target:{value:decision}});
 b.render();await b.handlers.submitDecision({preventDefault(){}});tree=b.render();
 if(decision==='buyer'&&notes.trim().length>=10){
  assert.equal(b.rpcCalls.length,1);assert.equal(b.rpcCalls[0].name,'decide_dispute');
  assert.equal(b.rpcCalls[0].args.p_notes,'a valid explanation');assert.match(text(tree),/Decision recorded\./);
 }else{assert.equal(b.rpcCalls.length,0);assert.match(text(tree),/at least 10 characters/)}
 count++;
}
console.log(`PASS: ${count} arbiter component scenarios with inert React/Supabase doubles. No live services or Bitcoin calls.`);
