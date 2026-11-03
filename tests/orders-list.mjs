import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ts=createRequire(path.join(root,'package.json'))('typescript');
const source=fs.readFileSync(path.join(root,'app/protected/orders/page.tsx'),'utf8')
 .replace('async function OrdersList()', 'export async function OrdersList()');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function nodes(tree,type){
 if(!tree||typeof tree!=='object')return [];
 if(Array.isArray(tree))return tree.flatMap(x=>nodes(x,type));
 return [...(tree.type===type?[tree]:[]),...nodes(tree.props?.children,type)];
}
function text(tree){
 if(tree==null||typeof tree==='boolean')return '';
 if(typeof tree!=='object')return String(tree);
 return Array.isArray(tree)?tree.map(text).join(' '):text(tree.props?.children);
}
const row={id:'synthetic-order',status:'CREATED',price_eur_cents:10000,created_at:'2026-10-30T00:00:00Z',
 buyer_id:'buyer',seller_id:'seller',listings:{title:'Synthetic listing'}};
async function render(options={}){
 let reads=0;
 const jsx=(type,props)=>({type,props});
 const context={exports:{},require(name){
  if(name==='react')return {Suspense:'suspense'};
  if(name==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'fragment'};
  if(name==='next/link')return {default:'link'};
  if(name==='@/lib/supabase/server')return {async createClient(){
   if(options.setupThrows)throw Error('Synthetic setup failure');
   return {auth:{async getUser(){
    if(options.authThrows)throw Error('Synthetic Auth connection failure');
    return {data:{user:options.signedOut?null:{id:options.user??'buyer'}},error:options.authError?{message:'Synthetic Auth failure'}:null};
   }},from(table){
    assert.equal(table,'orders');reads++;
    return {select(){return {async order(){
     if(options.queryThrows)throw Error('Synthetic database connection failure');
     return {data:options.rows??[],error:options.queryError?{message:'Internal database details must not leak'}:null};
    }}}};
   }};
  }};
  throw Error('Unexpected import: '+name);
 }};
 vm.runInNewContext(code,context);
 return {tree:await context.exports.OrdersList(),get reads(){return reads}};
}
let checks=0;
for(const options of [{setupThrows:true},{authThrows:true},{queryThrows:true},{queryError:true},{queryError:true,rows:[row]}]){
 const result=await render(options),content=text(result.tree);
 assert.match(content,/orders could not be loaded/);
 assert.doesNotMatch(content,/No orders yet|Synthetic listing|Internal database/);
 assert.equal(nodes(result.tree,'form')[0].props.action,'/protected/orders');
 assert.equal(nodes(result.tree,'form')[0].props.method,'get');
 assert.equal(nodes(result.tree,'div')[0].props.role,'alert');checks++;
}
for(const options of [{signedOut:true},{authError:true},{authError:true,user:'buyer'}]){
 const result=await render(options);
 assert.equal(result.reads,0);assert.match(text(result.tree),/session could not be verified/);
 assert.doesNotMatch(text(result.tree),/No orders yet|You are selling/);
 assert.equal(nodes(result.tree,'a')[0].props.href,'/auth/login');checks++;
}
const empty=await render();assert.match(text(empty.tree),/No orders yet/);assert.equal(nodes(empty.tree,'a').length,0);checks++;
for(const [user,label] of [['buyer','You are buying'],['seller','You are selling']]){
 const result=await render({user,rows:[row]});
 assert.match(text(result.tree),new RegExp(label));assert.match(text(result.tree),/100\.00\s+EUR/);
 assert.equal(nodes(result.tree,'link')[0].props.href,'/protected/orders/synthetic-order');checks++;
}
const missing=await render({rows:[{...row,listings:null}]});assert.equal(text(nodes(missing.tree,'link')[0]),'Listing');checks++;
console.log(`PASS: ${checks} orders-list scenarios. Auth and database are inert doubles; no real orders or credentials.`);
