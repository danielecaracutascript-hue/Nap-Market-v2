import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const req=createRequire(path.join(root,'package.json'));
const ts=req('typescript');
function load(file,resolve){
 const compiled=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017}}).outputText;
 const context={exports:{},require:resolve};vm.runInNewContext(compiled,context);return context.exports;
}
const settlements=load('lib/escrow-settlement.ts',name=>{assert.equal(name,'server-only');return {}});
const helper=load('lib/escrow-submission.ts',name=>{
 if(name==='server-only')return {};
 if(name==='node:crypto'||name==='bitcoinjs-lib')return req(name);
 if(name==='./escrow-settlement')return settlements;
 throw Error('Unexpected import '+name);
});
// Unsigned synthetic transaction, zero-value OP_RETURN and nonexistent input.
// Parsing/getId are read-only operations; no signatures, finalization or RPCs.
const raw='0200000001'+'00'.repeat(32)+'0000000000ffffffff010000000000000000016a00000000';
const args={orderId:'order-a',purpose:'release',txHex:raw,fundingTxid:'b'.repeat(64),fundingVout:2,psbtId:'draft-a'};
const expected=req('bitcoinjs-lib').Transaction.fromHex(raw).getId();
function database(options={}){
 const rows=new Map();const calls=[];
 const admin={
  async rpc(name,p){
   calls.push({name,p});assert.equal(name,'claim_escrow_submission');
   await Promise.resolve(); // Exercise callers sharing the persistent-store contract.
   if(options.rpcError)return {data:null,error:{message:'unavailable'}};
   let row=rows.get(p.p_order),acquired=false;
   if(!row){
    if([...rows.values()].some(r=>r.funding_txid===p.p_funding_txid&&r.funding_vout===p.p_funding_vout))return {data:null,error:{message:'duplicate outpoint'}};
    row={order_id:p.p_order,purpose:p.p_purpose,txid:p.p_txid,claim_id:p.p_claim_id,state:'pending',funding_txid:p.p_funding_txid,funding_vout:p.p_funding_vout};
    rows.set(p.p_order,row);acquired=true;
   }
   if(options.lostResponse)return {data:null,error:{message:'response lost after commit'}};
   let data={...row,acquired};if(options.mutate)data=options.mutate(data);
   return {data,error:null};
  },
  from(table){
   assert.equal(table,'escrow_submission_claims');const filters={};let states=null,update=null;
   return {select(){return this},eq(key,value){filters[key]=value;return this},in(key,value){assert.equal(key,'state');states=value;return this},update(value){assert.deepEqual(Object.keys(value).sort(),['acknowledged_at','state']);update=value;return this},async maybeSingle(){
    if(options.readError)return {data:null,error:{message:'missing table'}};
    const row=rows.get(filters.order_id);
    const matches=row&&Object.entries(filters).every(([k,v])=>row[k]===v)&&(!states||states.includes(row.state));
    if(!matches)return {data:null,error:null};
    if(update){if(options.writeError)return {data:null,error:{message:'write failure'}};Object.assign(row,update)}
    return {data:{...row},error:null};
   }};
  },
 };
 return {admin,rows,calls};
}
let db=database();
const pair=await Promise.all([helper.claimSubmission(db.admin,args),helper.claimSubmission(db.admin,args)]);
assert.equal(pair.filter(x=>x.acquired).length,1);assert.equal(db.rows.size,1);
assert.equal(pair[0].txid,expected);assert.equal(pair[1].txid,expected);
assert.equal(db.calls[0].p.p_funding_txid,args.fundingTxid);assert.equal(db.calls[0].p.p_psbt_id,args.psbtId);
const first=pair.find(x=>x.acquired);
const pending=await helper.recordedSubmission(db.admin,args.orderId);assert.equal(pending.broadcast,false);assert.equal(pending.submissionPending,true);assert.equal(pending.txid,expected);
const opposite=await helper.claimSubmission(db.admin,{...args,purpose:'refund'});assert.equal(opposite.acquired,false);
await assert.rejects(()=>helper.claimSubmission(db.admin,{...args,orderId:'order-b'}),helper.SubmissionCoordinationError);
assert.equal(await helper.saveSubmissionState(db.admin,args.orderId,'wrong-claim',expected,'broadcast'),false);
assert.equal(await helper.saveSubmissionState(db.admin,args.orderId,first.claimId,expected,'broadcast'),true);
assert.equal((await helper.recordedSubmission(db.admin,args.orderId)).broadcast,true);
assert.equal(await helper.saveSubmissionState(db.admin,args.orderId,first.claimId,expected,'reconciled'),true);
assert.equal((await helper.recordedSubmission(db.admin,args.orderId)).reconciliationRequired,false);
assert.equal(await helper.saveSubmissionState(db.admin,args.orderId,first.claimId,expected,'broadcast'),false);
assert.equal(db.rows.get(args.orderId).txid,expected);
assert.equal(db.rows.get(args.orderId).state,'reconciled');
for(const mutate of [r=>({...r,txid:'invalid'}),r=>({...r,txid:'c'.repeat(64)}),r=>({...r,claim_id:'wrong'}),r=>({...r,order_id:'other'}),r=>({...r,purpose:'refund'}),r=>({...r,acquired:'true'}),r=>({...r,state:'broadcast'})]){
 db=database({mutate});await assert.rejects(()=>helper.claimSubmission(db.admin,args),helper.SubmissionCoordinationError);
}
db=database({rpcError:true});await assert.rejects(()=>helper.claimSubmission(db.admin,args),helper.SubmissionCoordinationError);
db=database({readError:true});await assert.rejects(()=>helper.recordedSubmission(db.admin,args.orderId),helper.SubmissionCoordinationError);
db=database({lostResponse:true});await assert.rejects(()=>helper.claimSubmission(db.admin,args),helper.SubmissionCoordinationError);
assert.equal(db.rows.size,1);assert.equal((await helper.recordedSubmission(db.admin,args.orderId)).submissionPending,true);
db=database({writeError:true});const claim=await helper.claimSubmission(db.admin,args);assert.equal(await helper.saveSubmissionState(db.admin,args.orderId,claim.claimId,expected,'broadcast'),false);assert.equal(db.rows.get(args.orderId).state,'pending');
console.log('PASS: actual local TXID parsing, claim validation, modeled shared-store contention, opposite-purpose/outpoint conflicts, lost claim responses and guarded state updates. PostgreSQL itself is not exercised.');
