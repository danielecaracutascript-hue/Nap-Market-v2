import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ts=createRequire(path.join(root,'package.json'))('typescript');
const source=fs.readFileSync(path.join(root,'app/protected/profile/page.tsx'),'utf8')
 .replace('  if (loading) return','  capture({save});\n  if (loading) return');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function browser(options={}){
 const states=[],writes=[],effects=[],pending=[];const ref={current:false};let index=0,handlers;
 const jsx=(type,props)=>({type,props});
 const profile={handle:'synthetic_name',country:'IT',seller_type:'professional',business_info:{business_name:'Synthetic Shop',vat_id:'SYNTHETIC-VAT'}};
 const context={exports:{},capture:value=>{handlers=value},require(name){
  if(name==='react')return {useRef:()=>ref,useEffect(effect){effects.push(effect)},useState(initial){
   const i=index++;if(!(i in states))states[i]=initial;return [states[i],value=>{states[i]=value}];
  }};
  if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};if(name==='next/link')return {default:'link'};
  if(name==='@/lib/supabase/client')return {createClient:()=>({auth:{async getUser(){
   if(options.authThrows)throw Error('Synthetic Auth failure');
   return {data:{user:options.guest?null:{id:options.actor??'buyer'}},error:options.authError?{}:null};
  }},from(table){assert.equal(table,'profiles');return {
   select(columns){assert.equal(columns,'handle, country, seller_type, business_info');return this},
   eq(column,id){assert.equal(column,'id');assert.equal(id,options.actor??'buyer');return this},
   async maybeSingle(){
    if(options.profileThrows)throw Error('Synthetic profile connection failure');
    if(options.deferProfile)return new Promise(resolve=>pending.push(resolve));
    return {data:options.missing?null:profile,error:options.profileError?{}:null};
   },upsert(row){writes.push(row);return {select(columns){assert.equal(columns,'id');return {async single(){
    if(options.saveThrows)throw Error('Synthetic save connection failure');
    if(options.deferSave)return new Promise(resolve=>pending.push(resolve));
    return {data:options.invalidAck?null:{id:row.id},error:options.saveError??null};
   }}}};},
  }}})};
  throw Error('Unexpected import '+name);
 }};
 vm.runInNewContext(code,context);
 const render=()=>{index=0;return context.exports.default()};render();
 return {states,writes,pending,render,get handlers(){return handlers},
  async load(){const cleanup=effects[0]();await tick();return cleanup}};
}
function nodes(tree,type){if(!tree||typeof tree!=='object')return [];if(Array.isArray(tree))return tree.flatMap(x=>nodes(x,type));return [...(tree.type===type?[tree]:[]),...nodes(tree.props?.children,type)]}
function text(tree){if(tree==null||typeof tree==='boolean')return '';if(typeof tree!=='object')return String(tree);return Array.isArray(tree)?tree.map(text).join(' '):text(tree.props?.children)}
const event={preventDefault(){}};let checks=0;
for(const options of [{guest:true},{authError:true},{authThrows:true},{profileError:true},{profileThrows:true}]){
 const b=browser(options);await b.load();const tree=b.render();
 assert.equal(nodes(tree,'input').length,0);assert.match(text(tree),/Reload profile/);
 await b.handlers.save(event);assert.equal(b.writes.length,0);checks++;
}
for(const missing of [false,true]){
 const b=browser({missing});await b.load();b.render();
 assert.equal(b.states[8],'buyer');if(!missing)assert.equal(b.states[0],'synthetic_name');
 await b.handlers.save(event);assert.equal(b.writes.length,1);assert.equal(b.writes[0].id,'buyer');
 assert.ok(!('wallet_xpub' in b.writes[0]));assert.ok(!('created_at' in b.writes[0]));
 assert.equal(b.states[5],'Profile saved.');assert.equal(b.states[9],false);checks++;
}
for(const change of [{actor:'other'},{guest:true},{authError:true}]){
 const options={},b=browser(options);await b.load();b.render();Object.assign(options,change);
 await b.handlers.save(event);assert.equal(b.writes.length,0);assert.match(text(b.render()),/session changed/);checks++;
}
for(const failure of [{saveThrows:true},{saveError:{code:'',message:'Connection failed'}},{invalidAck:true}]){
 const b=browser(failure);await b.load();b.render();const sameHandler=b.handlers.save;await sameHandler(event);
 await sameHandler(event);assert.equal(b.writes.length,1);
 assert.equal(b.states[10],true);assert.equal(b.states[9],false);assert.match(text(b.render()),/Saving could not be confirmed/);
 assert.equal(nodes(b.render(),'fieldset')[0].props.disabled,true);
 await b.handlers.save(event);assert.equal(b.writes.length,1);assert.equal(b.states[0],'synthetic_name');checks++;
}
const rejected=browser({saveError:{code:'23505',message:'Synthetic duplicate handle'}});await rejected.load();rejected.render();
await rejected.handlers.save(event);assert.equal(rejected.states[10],false);assert.match(rejected.states[5],/duplicate handle/);checks++;
const duplicate=browser({deferSave:true});await duplicate.load();duplicate.render();
const first=duplicate.handlers.save(event);await duplicate.handlers.save(event);await tick();
assert.equal(duplicate.writes.length,1);assert.equal(nodes(duplicate.render(),'fieldset')[0].props.disabled,true);
duplicate.pending[0]({data:{id:'buyer'},error:null});await first;assert.equal(duplicate.states[9],false);checks++;
const unmounted=browser({deferProfile:true});const cleanup=await unmounted.load();cleanup();
unmounted.pending[0]({data:{handle:'stale'},error:null});await tick();assert.equal(unmounted.states[8],'');assert.equal(unmounted.states[0],'');checks++;
console.log(`PASS: ${checks} profile UI scenarios. Auth/database are inert doubles; no real profiles, wallet or Bitcoin access.`);
