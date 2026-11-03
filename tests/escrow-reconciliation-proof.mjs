import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const req=createRequire(path.join(root,'package.json'));
const ts=req('typescript'),bitcoin=req('bitcoinjs-lib'),descriptors=req('@bitcoinerlab/descriptors');
function load(file,resolve,globals={}){
 const code=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017}}).outputText;
 const context={...globals,exports:{},require:resolve,Buffer};vm.runInNewContext(code,context);return context.exports;
}
const legacy=load('lib/escrow-legacy-policy.ts',()=>{throw Error('Unexpected import')});
const proofModule=load('lib/escrow-reconciliation.ts',name=>{
 if(name==='server-only')return {};
 if(name==='bitcoinjs-lib'||name==='@bitcoinerlab/descriptors')return req(name);
 if(name==='./escrow-legacy-policy')return legacy;
 if(name==='./bitcoin')return {rpc(){throw Error('Live RPC forbidden')}};
 throw Error('Unexpected import '+name);
});
// Public curve point and synthetic chain codes; no seeds or private keys.
const publicPoint=Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798','hex');
const key=n=>{
 const node=descriptors.BIP32.fromPublicKey(publicPoint,Buffer.alloc(32,n),bitcoin.networks.testnet);
 return `[${Buffer.from(node.fingerprint).toString('hex')}/84h/1h/0h]${node.derive(84).derive(1).derive(0).toBase58()}`;
};
const keys={buyer:key(1),seller:key(2),platform:key(3)};
const k=(key,branch)=>`${key}/${branch}/*`;
const descriptor=`wsh(or_i(and_v(v:pk(${k(keys.platform,0)}),or_d(pk(${k(keys.buyer,0)}),pk(${k(keys.seller,0)}))),or_i(and_v(v:multi(2,${k(keys.buyer,2)},${k(keys.seller,2)}),older(5)),and_v(v:pk(${k(keys.buyer,1)}),older(10)))))`;
const normalize=d=>d.replace(/\[[^\]]*\]/g,origin=>origin.replace(/(\d)h/g,"$1'"));
const index=42,network=bitcoin.networks.regtest;
const policy=new descriptors.Output({descriptor:normalize(descriptor),index,network});
const payout=key=>bitcoin.payments.p2wpkh({pubkey:descriptors.BIP32.fromBase58(key.replace(/^\[[^\]]*\]/,''),network).derive(3).derive(index).publicKey,network}).output;
function fixture(purpose='release',refundKind='no_shipment',options={}){
 const funding=new bitcoin.Transaction();funding.addInput(Buffer.alloc(32),0xfffffffe);funding.addOutput(options.fundingScript??policy.getScriptPubKey(),BigInt(options.fundingSats??104000));
 const psbt=new bitcoin.Psbt({network});psbt.setVersion(2);
 psbt.addInput({hash:funding.getId(),index:0,sequence:0xfffffffd,witnessUtxo:{script:policy.getScriptPubKey(),value:BigInt(options.psbtSats??104000)},witnessScript:policy.getWitnessScript()});
 const commission=purpose==='release'?8000:(refundKind==='return'?4000:0);
 psbt.addOutput({script:options.destination??payout(purpose==='release'?keys.seller:keys.buyer),value:BigInt(options.recipientSats??(104000-commission-1000))});
 if(purpose==='release'||commission>0)psbt.addOutput({script:payout(keys.platform),value:BigInt(options.commissionSats??commission)});
 if(options.extraOutput)psbt.addOutput({script:Buffer.from([bitcoin.opcodes.OP_RETURN]),value:BigInt(0)});
 const tx=new bitcoin.Transaction();tx.version=psbt.version;tx.locktime=psbt.locktime;
 for(const input of psbt.txInputs)tx.addInput(input.hash,input.index,input.sequence);
 for(const output of psbt.txOutputs)tx.addOutput(output.script,output.value);
 return {
  order:{id:'order',status:purpose==='release'?'COMPLETED':'REFUNDED',escrow_index:index,escrow_descriptor:descriptor,escrow_address:policy.getAddress(),funding_txid:funding.getId(),funding_vout:0,price_sats:100000,buyer_commission_sats:4000,seller_commission_sats:4000,released_txid:null,refunded_txid:null},
  claim:{order_id:'order',purpose,txid:tx.getId(),funding_txid:funding.getId(),funding_vout:0,psbt_id:'draft',claim_id:'claim',state:'pending'},
  psbtBase64:psbt.toBase64(),network:'regtest',refundKind:purpose==='refund'?refundKind:null,raw:tx.toHex(),fundingRaw:funding.toHex(),
 };
}
let verified=0,rejected=0;
async function check(f,options={},expected=false){
 const calls=[];const blockhash='a'.repeat(64);
 const read=async(method,params=[],wallet)=>{
  calls.push({method,params,wallet});assert.ok(['getblockchaininfo','gettransaction','getrawtransaction','getblockheader','getblockhash'].includes(method),'Only read RPCs are allowed');
  if(options.failMethod===method)throw Error('simulated RPC failure');
  if(method==='getblockchaininfo')return {chain:options.chain??'regtest',initialblockdownload:options.ibd??false};
  const response={txid:f.claim.txid,hex:options.wrongHex??f.raw,blockhash,confirmations:options.confirmations??2};
  if(method==='gettransaction'){
   if(options.walletMissing)throw Error('wallet unavailable');
   return params[0]===f.claim.txid?response:{hex:options.fundingHex??f.fundingRaw};
  }
  if(method==='getrawtransaction'){
   if(params.length===3)return {...response,hex:options.includedHex??response.hex,blockhash:options.blockhash??blockhash,in_active_chain:options.active??true};
   return params[0]===f.claim.txid?response:{hex:options.fundingHex??f.fundingRaw};
  }
  if(method==='getblockheader')return {hash:blockhash,height:10,confirmations:options.headerConfirmations??2};
  if(method==='getblockhash')return options.reorg?'c'.repeat(64):blockhash;
 };
 const result=await proofModule.verifyReservedSettlement(f,read);
 assert.equal(result.verified,expected,result.reason);
 if(expected){verified++;assert.equal(result.txid,f.claim.txid);assert.equal(result.confirmations,2)}else{rejected++;assert.equal(typeof result.reason,'string')}
 return {result,calls};
}
for(const [purpose,reason]of [['release',null],['refund','return'],['refund','dispute'],['refund','no_shipment']])await check(fixture(purpose,reason),{},true);
await check(fixture('release',null,{psbtSats:1}),{},true); // Actual funding value, not PSBT metadata.
await check(fixture(),{walletMissing:true},true);
for(const options of [{chain:'main'},{ibd:true},{confirmations:0},{confirmations:-1},{active:false},{blockhash:'b'.repeat(64)},{headerConfirmations:-1},{reorg:true},{failMethod:'gettransaction',walletMissing:true,wrongHex:'00'},{failMethod:'getrawtransaction'},{failMethod:'getblockchaininfo'},{failMethod:'getblockheader'},{failMethod:'getblockhash'},{wrongHex:fixture('refund').raw},{includedHex:fixture('refund').raw},{fundingHex:'00'}])await check(fixture(),options);
for(const f of [
 {...fixture(),network:'mainnet'},
 {...fixture(),order:{...fixture().order,escrow_address:'wrong-address'}},
 {...fixture(),order:{...fixture().order,escrow_index:-1}},
 {...fixture(),order:{...fixture().order,funding_vout:1}},
 {...fixture(),order:{...fixture().order,price_sats:99999}},
 {...fixture(),order:{...fixture().order,seller_commission_sats:-1}},
 {...fixture(),order:{...fixture().order,status:'DISPUTED'}},
 {...fixture(),order:{...fixture().order,refunded_txid:'e'.repeat(64)}},
 {...fixture(),claim:{...fixture().claim,order_id:'another'}},
 {...fixture(),psbtBase64:fixture('refund').psbtBase64},
 {...fixture('refund'),refundKind:null},
 fixture('release',null,{fundingSats:105000}),
 fixture('release',null,{fundingScript:payout(keys.buyer)}),
 fixture('release',null,{destination:payout(keys.buyer)}),
 fixture('release',null,{commissionSats:7999}),
 fixture('release',null,{recipientSats:90000}),
 fixture('release',null,{recipientSats:104000}),
 fixture('release',null,{extraOutput:true}),
])await check(f);
console.log(`PASS: ${verified} positive and ${rejected} negative public-data proof scenarios. Read RPCs are mocked; no signatures, finalization or broadcast.`);
