import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=path.dirname(app);
assert.equal(root.toLowerCase(),'c:\\progetti');
const runtime=path.join(root,'work/integration-local');
const project='nap-market-isolated-20261030',dockerBin='C:\\Users\\Daniele\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin';
function run(exe,args,input){
 const result=spawnSync(exe,args,{cwd:root,encoding:'utf8',input,windowsHide:true,timeout:45000,maxBuffer:16*1024*1024,
  env:{...process.env,PATH:dockerBin+path.delimiter+process.env.PATH,DOCKER_HOST:'npipe:////./pipe/dockerDesktopLinuxEngine'}});
 if(result.status!==0)throw Error('Preview setup command failed; output withheld to avoid credentials.');return result.stdout;
}
const docker=path.join(dockerBin,'docker.exe');
const running=run(docker,['--host','npipe:////./pipe/dockerDesktopLinuxEngine','ps','--format','{{.Names}} {{.Ports}}']);
assert.ok(running.includes('supabase_db_'+project));
for(const line of running.split('\n').filter(line=>line.includes(project)))assert.ok(!line.includes('0.0.0.0:')&&!line.includes('[::]:'));
const config=JSON.parse(run(path.join(runtime,'tools/node_modules/@supabase/cli-windows-x64/bin/supabase.exe'),['status','--workdir',path.join(runtime,'stack'),'-o','json']));
assert.equal(config.API_URL,'http://127.0.0.1:54321');
const req=createRequire(path.join(app,'package.json')),{createClient}=req('@supabase/supabase-js');
const admin=createClient(config.API_URL,config.SECRET_KEY??config.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(url,options)=>{
 assert.equal(new URL(url).origin,config.API_URL);return fetch(url,options);
}}});
const sql=source=>run(docker,['--host','npipe:////./pipe/dockerDesktopLinuxEngine','exec','-i','supabase_db_'+project,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-f','-'],source);
sql(fs.readFileSync(path.join(app,'tests/fixtures/local-browser-checkout.sql'),'utf8'));
sql(fs.readFileSync(path.join(app,'tests/fixtures/local-profile-privacy.sql'),'utf8'));
sql(fs.readFileSync(path.join(app,'supabase/security/separate-public-profiles.sql'),'utf8'));
for(const file of ['fix-address-access.sql','fix-quote-validation.sql','fix-create-order-guard.sql'])sql(fs.readFileSync(path.join(app,'supabase/security',file),'utf8'));
sql("NOTIFY pgrst, 'reload schema';");
for(let attempt=0;attempt<30;attempt++){
 const ready=await admin.from('listings').select('title').limit(1);if(!ready.error)break;
 if(attempt===29)throw Error('Local preview schema unavailable');await new Promise(resolve=>setTimeout(resolve,200));
}
async function user(role){
 const email=`preview-${role}-${randomUUID()}@example.test`;
 const generated=await admin.auth.admin.generateLink({type:'magiclink',email});
 if(generated.error)throw Error('Synthetic preview user creation failed');
 const id=generated.data.user.id;
 assert.equal((await admin.from('profiles').insert({id,handle:'preview-'+role,country:'IT',seller_type:'private'})).error,null);
 return {id,email};
}
const buyer=await user('buyer'),seller=await user('seller');
const listingId=randomUUID();
assert.equal((await admin.from('listings').insert({id:listingId,seller_id:seller.id,title:'Synthetic browser checkout',description:'Synthetic listing for local browser verification.',category:'Books',condition:'good',price_eur_cents:10000,package_size:'small',ship_from_country:'IT',photos:[],status:'active'})).error,null);
assert.equal((await admin.from('addresses').insert({user_id:buyer.id,country:'IT',encrypted_payload:'\\x'+Buffer.from('Synthetic test address - not a real person').toString('hex')})).error,null);
assert.equal((await admin.from('fx_rates').insert({btc_eur:100000,fetched_at:new Date().toISOString()})).error,null);
assert.equal((await admin.from('shipping_rates').insert({from_country:'IT',to_country:'IT',package_size:'small',price_eur_cents:1000})).error,null);
const preview=fs.mkdtempSync(path.join(runtime,'browser-preview-'));
const tracked=run('git',['ls-tree','-r','--name-only','HEAD','--','marketplace/app','marketplace/lib','marketplace/components','marketplace/public']).trim().split('\n');
for(const name of tracked){
 if(!/\.(?:ts|tsx|css|ico|svg|png|jpe?g|webp|json)$/.test(name)||/\.bak|\/wallet\/|escrow-v2|poc-firma/.test(name))continue;
 const relative=name.slice('marketplace/'.length),target=path.join(preview,relative);
 fs.mkdirSync(path.dirname(target),{recursive:true});
 // git show emits only committed code/assets; no .env, working-tree wallet or backup.
 const content=spawnSync('git',['show','HEAD:'+name],{cwd:root,encoding:null,maxBuffer:16*1024*1024});
 assert.equal(content.status,0);fs.writeFileSync(target,content.stdout);
}
for(const file of ['package.json','tsconfig.json','next.config.ts','postcss.config.mjs','tailwind.config.ts','tailwind.config.js','proxy.ts']){
 const result=spawnSync('git',['show','HEAD:marketplace/'+file],{cwd:root,encoding:'utf8'});
 if(result.status===0)fs.writeFileSync(path.join(preview,file),result.stdout);
}
fs.symlinkSync(path.join(app,'node_modules'),path.join(preview,'node_modules'),'junction');
// Preview-only fallback avoids external font fetches; application files unchanged.
const layoutFile=path.join(preview,'app/layout.tsx');
let layout=fs.readFileSync(layoutFile,'utf8').replace('import { Geist } from "next/font/google";','');
layout=layout.replace(/const geistSans = Geist\([\s\S]*?\);/,'const geistSans = { className: "" };');fs.writeFileSync(layoutFile,layout);
// This local-only route issues fresh synthetic sessions without exposing tokens.
const loginDir=path.join(preview,'app/auth/integration-login');fs.mkdirSync(loginDir,{recursive:true});
fs.writeFileSync(path.join(loginDir,'route.ts'),`import {NextResponse} from 'next/server';
import {createClient} from '@/lib/supabase/server';
import {createAdminClient} from '@/lib/supabase/admin';
export async function GET(request:Request){
 const url=new URL(request.url);
 if(request.headers.get('host')!=='127.0.0.1:3100'||process.env.INTEGRATION_PREVIEW!=='1')return new Response('Unavailable',{status:404});
 const email=url.searchParams.get('as')==='seller'?process.env.INTEGRATION_SELLER_EMAIL!:process.env.INTEGRATION_BUYER_EMAIL!;
 const result=await createAdminClient().auth.admin.generateLink({type:'magiclink',email});
 if(result.error)return new Response('Synthetic login unavailable',{status:503});
 const session=await createClient();
 const verified=await session.auth.verifyOtp({type:result.data.properties.verification_type as 'signup'|'magiclink',token_hash:result.data.properties.hashed_token});
 if(verified.error)return new Response('Synthetic session unavailable',{status:503});
 return NextResponse.redirect(new URL('/protected/listings/'+process.env.INTEGRATION_LISTING_ID+'/buy','http://127.0.0.1:3100'));
}`);
for(const purpose of ['release','refund']){
 const target=path.join(preview,`app/api/orders/[id]/${purpose}/submit/route.ts`);
 fs.writeFileSync(target,"export async function POST(){return Response.json({error:'Signing and broadcast disabled in isolated preview'},{status:503})}\n");
}
const env={SystemRoot:process.env.SystemRoot,windir:process.env.SystemRoot,ComSpec:path.join(process.env.SystemRoot,'System32/cmd.exe'),
 PATH:path.dirname(process.execPath)+path.delimiter+path.join(process.env.SystemRoot,'System32'),TEMP:preview,TMP:preview,
 NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',NEXT_PUBLIC_SUPABASE_URL:config.API_URL,
 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:config.PUBLISHABLE_KEY??config.ANON_KEY,SUPABASE_SECRET_KEY:config.SECRET_KEY??config.SERVICE_ROLE_KEY,
 NEXT_PUBLIC_BITCOIN_NETWORK:'regtest',NEXT_PUBLIC_TEST_MODE:'false',BITCOIN_RPC_URL:'http://127.0.0.1:19443',
 BITCOIN_RPC_COOKIE_PATH:path.join(runtime,'regtest-readonly/regtest/.cookie'),
 INTEGRATION_PREVIEW:'1',INTEGRATION_BUYER_EMAIL:buyer.email,INTEGRATION_SELLER_EMAIL:seller.email,INTEGRATION_LISTING_ID:listingId};
const log=fs.openSync(path.join(preview,'next-preview.log'),'a');
const processHandle=spawn(process.execPath,[path.join(app,'node_modules/next/dist/bin/next'),'dev','--webpack','--hostname','127.0.0.1','--port','3100'],
 {cwd:preview,env,windowsHide:true,detached:true,stdio:['ignore',log,log]});processHandle.unref();fs.closeSync(log);
fs.writeFileSync(path.join(runtime,'browser-preview.json'),JSON.stringify({preview,pid:processHandle.pid,url:'http://127.0.0.1:3100/auth/integration-login',listingId,buyerId:buyer.id,sellerId:seller.id,signingDisabled:true},null,2));
console.log('Isolated Next preview requested on 127.0.0.1:3100. Synthetic login has no password or tokens in URL. Signing/broadcast endpoints disabled.');
