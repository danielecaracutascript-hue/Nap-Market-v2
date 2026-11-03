import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

// This runner creates its own PostgreSQL cluster. It accepts no database URL,
// loads no app configuration and never imports Bitcoin or signing modules.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtime=path.resolve(process.argv[2]??path.join(root,'..','work','pg-validation'));
const runtimeReq=createRequire(path.join(runtime,'package.json'));
const {Client}=runtimeReq('pg');
const binaries=await import(pathToFileURL(runtimeReq.resolve('@embedded-postgres/windows-x64')).href);
const runDir=fs.mkdtempSync(path.join(runtime,'run-'));
const dataDir=path.join(runDir,'cluster');
const logFile=path.join(runDir,'postgres.log');
const systemRoot=process.env.SystemRoot;
const childEnv={SystemRoot:systemRoot,windir:systemRoot,ComSpec:path.join(systemRoot,"System32","cmd.exe"),PATH:path.dirname(binaries.postgres)+path.delimiter+path.join(systemRoot,"System32"),TEMP:runDir,TMP:runDir};
let running=false,port;
let clients=[];
const passed=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function cli(exe,args){
 const outputPath=path.join(runDir,path.basename(exe)+'.log');
 const output=fs.openSync(outputPath,'a');
 let result;
 try{result=spawnSync(exe,args,{windowsHide:true,timeout:45000,env:childEnv,stdio:['ignore',output,output]})}finally{fs.closeSync(output)}
 if(result.error||result.status!==0)throw Error(`${path.basename(exe)} failed (status ${result.status}, signal ${result.signal}): ${result.error?.message??''}\n${fs.readFileSync(outputPath,'utf8').slice(-4000)}`);
 return fs.readFileSync(outputPath,'utf8');
}
async function freePort(){
 const listener=net.createServer();
 await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve)});
 const selected=listener.address().port;await new Promise(resolve=>listener.close(resolve));return selected;
}
function start(){
 running=true;
 cli(binaries.pg_ctl,['start','-D',dataDir,'-l',logFile,'-o',`-h 127.0.0.1 -p ${port} -c fsync=on -c synchronous_commit=on -c max_connections=16 -c shared_buffers=16MB`,'-w','-t','20']);
 running=true;
}
function stop(){
 if(running){cli(binaries.pg_ctl,['stop','-D',dataDir,'-m','fast','-w','-t','20']);running=false}
}
async function closeClients(){
 const active=clients;clients=[];await Promise.allSettled(active.map(client=>client.end()));
}
async function connect(role='postgres'){
 // Explicit localhost settings + a password callback prevent use of PG* secrets.
 const client=new Client({host:'127.0.0.1',port,user:role==='bootstrap'?'escrow_bootstrap':'postgres',database:'postgres',password:async()=>'',ssl:false,connectionTimeoutMillis:5000,application_name:'isolated-escrow-verification'});
 await client.connect();clients.push(client);
 const actual=(await client.query('SHOW data_directory')).rows[0].data_directory;
 assert.equal(path.resolve(actual).toLowerCase(),path.resolve(dataDir).toLowerCase(),'Refusing a database outside this new test cluster');
 if(role!=='postgres'&&role!=='bootstrap'){
  assert.ok(['anon','authenticated','service_role'].includes(role));
  await client.query(`SET ROLE ${role}`);
 }
 return client;
}
let counter=1;
const uuid=()=>`00000000-0000-4000-8000-${String(counter++).padStart(12,'0')}`;
const hex=n=>BigInt(n).toString(16).padStart(64,'0');
async function order(db,options={}){
 const row={id:uuid(),draft:uuid(),status:options.status??'COMPLETED',purpose:options.purpose??'release',funding:options.funding??hex(counter+1000),vout:2,txid:hex(counter+10000)};
 await db.query('INSERT INTO public.orders(id,status,funding_txid,funding_vout,escrow_descriptor) VALUES ($1,$2,$3,$4,$5)',[row.id,row.status,row.funding,row.vout,'synthetic-public-policy']);
 await db.query('INSERT INTO public.psbts(id,order_id,purpose,status) VALUES ($1,$2,$3,$4)',[row.draft,row.id,row.purpose,options.draftStatus??'draft']);
 return row;
}
function claim(db,row,options={}){
 return db.query('SELECT public.claim_escrow_submission($1::uuid,$2,$3,$4,$5::bigint,$6,$7::uuid) AS result',[
  row.id,options.purpose??row.purpose,options.txid??row.txid,options.funding??row.funding,options.vout??row.vout,options.draft??row.draft,options.claimId??uuid(),
 ]).then(result=>result.rows[0].result);
}
async function denied(action,code='42501'){
 await assert.rejects(action,error=>error.code===code);
}
async function blocked(observer,pid,by){
 const until=Date.now()+5000;
 while(Date.now()<until){
  const row=(await observer.query('SELECT pg_blocking_pids($1) AS blockers',[pid])).rows[0];
  if(row.blockers.includes(by))return;
  await delay(25);
 }
 throw Error('Second PostgreSQL session did not wait for the first session lock');
}
async function test(name,action){await action();passed.push(name);console.log('PASS: '+name)}
try{
 port=await freePort();
 cli(binaries.initdb,['-D',dataDir,'--username=escrow_bootstrap','--auth=trust','--locale=C','--encoding=UTF8','--no-instructions']);
 start();
 const bootstrap=await connect('bootstrap');
 console.log('Isolated PostgreSQL '+(await bootstrap.query('SHOW server_version')).rows[0].server_version);
 if(process.argv.includes('--profile-privacy')){
  const {runProfilePrivacyTests}=await import('./profile-privacy-postgres.mjs');
  await runProfilePrivacyTests(bootstrap,root,connect);
  await closeClients();stop();process.exit(0);
 }
 if(process.argv.includes('--profile-audit')){
  const {runProfileAuditTests}=await import('./profile-audit-postgres.mjs');
  await runProfileAuditTests(bootstrap,root);
  await closeClients();stop();process.exit(0);
 }
 if(process.argv.includes('--remaining-rpc-paths')){
  const {runRemainingRpcPathTests}=await import('./remaining-rpc-paths-postgres.mjs');
  await runRemainingRpcPathTests(bootstrap,root);
  await closeClients();stop();process.exit(0);
 }
 if(process.argv.includes('--security-verification')){
  const {runSecurityVerificationTests}=await import('./security-verification-postgres.mjs');
  await runSecurityVerificationTests(bootstrap,root);
  await closeClients();stop();process.exit(0);
 }
 if(process.argv.includes('--finalize-order')){
  const {runFinalizeOrderTests}=await import('./finalize-order-postgres.mjs');
  await runFinalizeOrderTests(bootstrap,root,connect);
  await closeClients();stop();process.exit(0);
 }
 if(process.argv.includes('--cancel-order')){
  const {runCancelOrderTests}=await import('./cancel-order-postgres.mjs');
  await runCancelOrderTests(bootstrap,root,connect);
  await closeClients();stop();process.exit(0);
 }
 if(process.argv.includes('--create-order')){
  const {runCreateOrderTests}=await import('./create-order-postgres.mjs');
  await runCreateOrderTests(bootstrap,root,()=>connect('bootstrap'));
 }else if(process.argv.includes('--quote-validation')){
  const {runQuoteTests}=await import('./quote-validation-postgres.mjs');
  await runQuoteTests(bootstrap,root);
 }else if(process.argv.includes('--checkout-guards')){
  const {runCheckoutGuardTests}=await import('./checkout-guards-postgres.mjs');
  await runCheckoutGuardTests(bootstrap,root,()=>connect('bootstrap'));
 }else if(process.argv.includes('--shipping-inputs')){
  const {runShippingTests}=await import('./shipping-inputs-postgres.mjs');
  await runShippingTests(bootstrap,root);
 }else if(process.argv.includes('--application-truncate')){
  const {runTableGuardTests}=await import('./table-guards-postgres.mjs');
  await runTableGuardTests(bootstrap,root,true);
 }else if(process.argv.includes('--escrow-creation')){
  const {runEscrowCreationTests}=await import('./escrow-creation-postgres.mjs');
  await runEscrowCreationTests(bootstrap,root,()=>connect('bootstrap'));
 }else if(process.argv.includes('--funding-http')){
  const {runFundingHttpTests}=await import('./funding-http-postgres.mjs');
  await runFundingHttpTests(bootstrap,root,()=>connect('bootstrap'));
 }else if(process.argv.includes('--funding-snapshot')){
  const {runFundingSnapshotTests}=await import('./funding-snapshot-postgres.mjs');
  await runFundingSnapshotTests(bootstrap,root,()=>connect('bootstrap'));
 }else if(process.argv.includes('--open-dispute')){
  const {runOpenDisputeTests}=await import('./open-dispute-postgres.mjs');
  await runOpenDisputeTests(bootstrap,root);
 }else if(process.argv.includes('--table-guards')){
  const {runTableGuardTests}=await import('./table-guards-postgres.mjs');
  await runTableGuardTests(bootstrap,root);
 }else if(process.argv.includes('--order-guards')){
  const {runOrderGuardTests}=await import('./order-guards-postgres.mjs');
  await runOrderGuardTests(bootstrap,root);
 }else{
 await bootstrap.query(fs.readFileSync(path.join(root,'tests','fixtures','escrow-claims-minimal.sql'),'utf8'));
 await bootstrap.query(fs.readFileSync(path.join(root,'tests','fixtures','escrow-reconciliation-legacy-stubs.sql'),'utf8'));
 let owner=await connect();
 const installation=await owner.query(fs.readFileSync(path.join(root,'supabase','security','add-escrow-submission-claims.sql'),'utf8'));
 const metadata=installation.at(-1).rows[0];
 assert.deepEqual(metadata,{claims_table:'escrow_submission_claims',anon:false,authenticated:false,service_role:true,anon_reads_claims:false,authenticated_reads_claims:false});
 const reconciliationInstallation=await owner.query(fs.readFileSync(path.join(root,'supabase','security','add-escrow-reconciliation.sql'),'utf8'));
 assert.deepEqual(reconciliationInstallation.at(-1).rows[0],{anon:false,authenticated:false,service_role:true});
 let a=await connect('service_role'),b=await connect('service_role');
 await test('exact installation script and grants under non-superuser owner',async()=>{
  const role=(await owner.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='postgres'")).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
 });
 await test('anonymous and authenticated callers cannot execute, read or insert',async()=>{
  const sample=await order(owner);
  for(const role of ['anon','authenticated']){
   const client=await connect(role);
   await denied(()=>client.query('SELECT public.reconcile_escrow_submission($1::uuid,$2::uuid,$3,$4::jsonb)',[sample.id,uuid(),sample.txid,{}]));
   await denied(()=>claim(client,sample));await denied(()=>client.query('SELECT * FROM public.escrow_submission_claims'));
   await denied(()=>client.query('INSERT INTO public.escrow_submission_claims DEFAULT VALUES'));
  }
 });
 await test('two real sessions compete for one order and one wins',async()=>{
  const row=await order(owner);const before=(await owner.query('SELECT row_to_json(o) AS row FROM public.orders o WHERE id=$1',[row.id])).rows[0].row;
  const pidA=(await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,pidB=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await a.query('BEGIN');const first=await claim(a,row);assert.equal(first.acquired,true);
  const contender=claim(b,row,{txid:hex(999999)});const result=contender.then(value=>({value}),error=>({error}));
  await blocked(owner,pidB,pidA);await a.query('COMMIT');const second=await result;if(second.error)throw second.error;
  assert.equal(second.value.acquired,false);assert.equal(second.value.txid,first.txid);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM public.escrow_submission_claims WHERE order_id=$1',[row.id])).rows[0].n,1);
  assert.deepEqual((await owner.query('SELECT row_to_json(o) AS row FROM public.orders o WHERE id=$1',[row.id])).rows[0].row,before);
 });
 await test('competing purpose cannot replace the existing reservation',async()=>{
  const row=await order(owner);const first=await claim(a,row);const second=await claim(b,row,{purpose:'refund',txid:hex(999998)});
  assert.equal(second.acquired,false);assert.equal(second.txid,first.txid);assert.equal(second.purpose,'release');
 });
 await test('two orders sharing one funding output cannot both acquire',async()=>{
  const one=await order(owner),two=await order(owner,{funding:one.funding});
  const pidA=(await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,pidB=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await a.query('BEGIN');await claim(a,one);
  const contender=claim(b,two);const result=contender.then(value=>({value}),error=>({error}));
  await blocked(owner,pidB,pidA);await a.query('COMMIT');const second=await result;assert.equal(second.error?.code,'23505');
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM public.escrow_submission_claims WHERE order_id=$1',[two.id])).rows[0].n,0);
 });
 await test('disconnect before commit rolls back an unsent reservation',async()=>{
  const row=await order(owner);const dropped=await connect('service_role');await dropped.query('BEGIN');await claim(dropped,row);await dropped.end();
  const retry=await claim(a,row);assert.equal(retry.acquired,true);
 });
 await test('committed reservation survives a lost client response',async()=>{
  const row=await order(owner);const dropped=await connect('service_role');await claim(dropped,row);await dropped.end();
  const receipt=await claim(b,row);assert.equal(receipt.acquired,false);assert.equal(receipt.state,'pending');assert.equal(receipt.txid,row.txid);
 });
 await test('invalid order state, draft and funding metadata create no claims',async()=>{
  const bad=await order(owner,{status:'CREATED'});await denied(()=>claim(a,bad),'P0001');
  const row=await order(owner);
  for(const options of [{funding:hex(999997)},{vout:3},{draft:uuid()},{purpose:'refund'},{txid:'invalid'}])await denied(()=>claim(a,row,options),'P0001');
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM public.escrow_submission_claims WHERE order_id IN ($1,$2)',[row.id,bad.id])).rows[0].n,0);
 });
 await test('historical broadcast PSBT blocks a new claim',async()=>{
  const row=await order(owner,{draftStatus:'broadcast'});await denied(()=>claim(a,row),'P0001');
 });
 await test('service role cannot insert, delete, or overwrite public identity',async()=>{
  const row=await order(owner);const current=await claim(a,row);
  await denied(()=>a.query('INSERT INTO public.escrow_submission_claims DEFAULT VALUES'));
  await denied(()=>a.query('DELETE FROM public.escrow_submission_claims WHERE order_id=$1',[row.id]));
  await denied(()=>a.query('UPDATE public.escrow_submission_claims SET txid=$1 WHERE order_id=$2',[hex(999996),row.id]));
  const wrong=await a.query("UPDATE public.escrow_submission_claims SET state='broadcast' WHERE order_id=$1 AND claim_id=$2 RETURNING order_id",[row.id,uuid()]);assert.equal(wrong.rowCount,0);
  const correct=await a.query("UPDATE public.escrow_submission_claims SET state='broadcast',acknowledged_at=now() WHERE order_id=$1 AND claim_id=$2 AND txid=$3 RETURNING order_id",[row.id,current.claim_id,current.txid]);assert.equal(correct.rowCount,1);
  const read=(await a.query('SELECT * FROM public.escrow_submission_claims WHERE order_id=$1',[row.id])).rows[0];assert.equal(read.txid,row.txid);assert.equal(read.state,'broadcast');
 });
 const durable=await order(owner);await claim(a,durable);
 await test('pending reservation survives PostgreSQL restart and still blocks retry',async()=>{
  await closeClients();stop();start();owner=await connect();a=await connect('service_role');b=await connect('service_role');
  const receipt=await claim(b,durable);assert.equal(receipt.acquired,false);assert.equal(receipt.state,'pending');assert.equal(receipt.txid,durable.txid);
 });
 await test('reserved refund works without changing the order or legacy PSBT',async()=>{
  const row=await order(owner,{status:'REFUNDED',purpose:'refund'});const first=await claim(a,row);assert.equal(first.acquired,true);
  const after=(await owner.query('SELECT status,released_txid,refunded_txid FROM public.orders WHERE id=$1',[row.id])).rows[0];assert.deepEqual(after,{status:'REFUNDED',released_txid:null,refunded_txid:null});
  assert.equal((await owner.query('SELECT status FROM public.psbts WHERE id=$1',[row.draft])).rows[0].status,'draft');
 });
 const snapshot=async(row)=>{
  const o=(await owner.query('SELECT * FROM public.orders WHERE id=$1',[row.id])).rows[0];
  const p=(await owner.query('SELECT psbt FROM public.psbts WHERE id=$1',[row.draft])).rows[0];
  return {escrow_descriptor:o.escrow_descriptor,escrow_address:o.escrow_address,escrow_index:String(o.escrow_index),price_sats:String(o.price_sats),buyer_commission_sats:String(o.buyer_commission_sats),seller_commission_sats:String(o.seller_commission_sats),psbt:p.psbt};
 };
 const reconcile=async(db,row,current,expected)=>db.query('SELECT public.reconcile_escrow_submission($1::uuid,$2::uuid,$3,$4::jsonb) AS result',[row.id,current.claim_id,current.txid,expected??await snapshot(row)]).then(r=>r.rows[0].result);
 const eventCount=async(row)=>(await owner.query('SELECT count(*)::int AS n FROM public.settlement_test_events WHERE order_id=$1',[row.id])).rows[0].n;
 const pendingSnapshot=async(row)=>{
  assert.equal((await owner.query('SELECT released_txid FROM public.orders WHERE id=$1',[row.id])).rows[0].released_txid,null);
  assert.equal((await owner.query('SELECT status FROM public.psbts WHERE id=$1',[row.draft])).rows[0].status,'draft');
  assert.equal((await owner.query('SELECT state FROM public.escrow_submission_claims WHERE order_id=$1',[row.id])).rows[0].state,'pending');
  assert.equal(await eventCount(row),0);
 };
 await test('atomic reconciliation is idempotent under two concurrent sessions',async()=>{
  const row=await order(owner),current=await claim(a,row);
  const before=(await owner.query('SELECT * FROM public.orders WHERE id=$1',[row.id])).rows[0];
  const pidA=(await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,pidB=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await a.query('BEGIN');assert.equal((await reconcile(a,row,current)).ok,true);
  const waiting=reconcile(b,row,current).then(value=>({value}),error=>({error}));
  await blocked(owner,pidB,pidA);await a.query('COMMIT');const second=await waiting;if(second.error)throw second.error;assert.equal(second.value.ok,true);
  const after=(await owner.query('SELECT * FROM public.orders WHERE id=$1',[row.id])).rows[0];assert.deepEqual(after,{...before,released_txid:row.txid});
  assert.equal(await eventCount(row),1);
  const draft=(await owner.query('SELECT psbt,status,txid FROM public.psbts WHERE id=$1',[row.draft])).rows[0];assert.deepEqual(draft,{psbt:'synthetic-psbt',status:'confirmed',txid:row.txid});
  assert.equal((await owner.query('SELECT state FROM public.escrow_submission_claims WHERE order_id=$1',[row.id])).rows[0].state,'reconciled');
  await reconcile(a,row,current);assert.equal(await eventCount(row),1);
 });
 await test('refund reconciliation uses the original refund function once',async()=>{
  const row=await order(owner,{status:'REFUNDED',purpose:'refund'}),current=await claim(a,row);await reconcile(a,row,current);await reconcile(b,row,current);
  const after=(await owner.query('SELECT status,released_txid,refunded_txid FROM public.orders WHERE id=$1',[row.id])).rows[0];assert.deepEqual(after,{status:'REFUNDED',released_txid:null,refunded_txid:row.txid});assert.equal(await eventCount(row),1);
 });
 for(const stage of ['legacy','psbt'])await test('reconciliation rolls back all writes after '+stage+' failure',async()=>{
  const row=await order(owner),current=await claim(a,row);await owner.query('INSERT INTO public.settlement_test_failures VALUES($1,$2)',[row.id,stage]);
  await denied(()=>reconcile(a,row,current),'P0001');await pendingSnapshot(row);
 });
 await test('reconciliation refuses a different claim or funding outpoint',async()=>{
  const row=await order(owner),current=await claim(a,row);await denied(()=>reconcile(a,row,{...current,claim_id:uuid()}),'P0001');
  await owner.query('UPDATE public.orders SET funding_vout=3 WHERE id=$1',[row.id]);await denied(()=>reconcile(a,row,current),'P0001');await pendingSnapshot(row);
 });
 await test('reconciliation refuses a silent legacy no-op',async()=>{
  const row=await order(owner),current=await claim(a,row);await owner.query('INSERT INTO public.settlement_test_failures VALUES($1,$2)',[row.id,'noop']);
  await denied(()=>reconcile(a,row,current),'P0001');await pendingSnapshot(row);
 });
 for(const change of ['price','descriptor','psbt'])await test('reconciliation refuses '+change+' changes after proof snapshot',async()=>{
  const row=await order(owner),current=await claim(a,row),expected=await snapshot(row);
  if(change==='price')await owner.query('UPDATE public.orders SET price_sats=price_sats+1 WHERE id=$1',[row.id]);
  if(change==='descriptor')await owner.query('UPDATE public.orders SET escrow_descriptor=$1 WHERE id=$2',['changed-policy',row.id]);
  if(change==='psbt')await owner.query('UPDATE public.psbts SET psbt=$1 WHERE id=$2',['changed-psbt',row.draft]);
  await denied(()=>reconcile(a,row,current,expected),'P0001');await pendingSnapshot(row);
 });
 const acknowledge=(db,row,current,expected)=>db.query('SELECT public.reconcile_escrow_submission($1::uuid,$2::uuid,$3,$4::jsonb,false,$5) AS result',[row.id,current.claim_id,current.txid,expected,'synthetic-signed-psbt']).then(r=>r.rows[0].result);
 for(const firstMode of ['acknowledgment','confirmation'])await test('simultaneous '+firstMode+' and reconciliation record one event',async()=>{
  const row=await order(owner),current=await claim(a,row),expected=await snapshot(row);
  const pidA=(await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,pidB=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await a.query('BEGIN');
  if(firstMode==='acknowledgment')await acknowledge(a,row,current,expected);else await reconcile(a,row,current,expected);
  const action=firstMode==='acknowledgment'?reconcile(b,row,current,expected):acknowledge(b,row,current,expected);
  const waiting=action.then(value=>({value}),error=>({error}));await blocked(owner,pidB,pidA);await a.query('COMMIT');const second=await waiting;
  if(firstMode==='acknowledgment'){assert.equal(second.error?.code,'P0001');await reconcile(b,row,current)}else{if(second.error)throw second.error;assert.equal(second.value.ok,true)}
  assert.equal(await eventCount(row),1);
  const p=(await owner.query('SELECT status,psbt,signed_by FROM public.psbts WHERE id=$1',[row.draft])).rows[0];assert.equal(p.status,'confirmed');assert.equal(p.psbt,'synthetic-signed-psbt');assert.deepEqual(p.signed_by,['seller','platform']);
 });
 await test('acknowledged recording supports JSONB signature metadata as well as SQL arrays',async()=>{
  await owner.query("ALTER TABLE public.psbts ALTER COLUMN signed_by DROP DEFAULT; ALTER TABLE public.psbts ALTER COLUMN signed_by TYPE jsonb USING to_jsonb(signed_by); ALTER TABLE public.psbts ALTER COLUMN signed_by SET DEFAULT '[]'::jsonb");
  const row=await order(owner),current=await claim(a,row),expected=await snapshot(row);await acknowledge(a,row,current,expected);
  const p=(await owner.query('SELECT status,signed_by,pg_typeof(signed_by)::text AS type FROM public.psbts WHERE id=$1',[row.draft])).rows[0];assert.equal(p.status,'broadcast');assert.equal(p.type,'jsonb');assert.deepEqual(p.signed_by,['seller','platform']);assert.equal(await eventCount(row),1);
 });
 fs.writeFileSync(path.join(runDir,'report.json'),JSON.stringify({postgres:'17.10',passed,total:passed.length,bitcoinCalls:0,remoteDatabaseCalls:0},null,2));
 console.log(`PASS: ${passed.length} real PostgreSQL integration checks. No Bitcoin or remote database calls.`);
 }
}finally{
 await closeClients();stop();console.log('Isolated PostgreSQL stopped. Synthetic cluster retained under work/pg-validation.');
}
