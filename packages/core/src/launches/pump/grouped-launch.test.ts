import {expect,test} from 'bun:test';
import {Keypair,PublicKey,SystemProgram,TransactionInstruction} from '@solana/web3.js';
import {groupPumpJitoDrafts,executePumpTokenLaunch} from './token-launch.ts';
import {CREATE_V2_D8,BUY_EXACT_QUOTE_IN_V2_D8,PUMP_PROGRAM_ID} from '../../venues/pump/constants.ts';
import {assembleTransaction} from '../../tx/assemble.ts';
const empty=()=>({instructions:[],signers:[],actions:[],trackedAccounts:[]});
function fixture(){
 const payer=Keypair.generate(),mint=Keypair.generate(),buyers=Array.from({length:8},()=>Keypair.generate()),tip=Keypair.generate().publicKey;
 const create=new TransactionInstruction({programId:PUMP_PROGRAM_ID,data:CREATE_V2_D8,keys:Array.from({length:16},(_,i)=>({pubkey:i===0?payer.publicKey:mint.publicKey,isSigner:i===1,isWritable:true}))});
 const plans=buyers.map((b,i)=>{const keys=Array.from({length:27},()=>({pubkey:mint.publicKey,isSigner:false,isWritable:false}));keys[13]={pubkey:b.publicKey,isSigner:true,isWritable:true};keys[24]={pubkey:SystemProgram.programId,isSigner:false,isWritable:false};keys[26]={pubkey:PUMP_PROGRAM_ID,isSigner:false,isWritable:false};const d:any={...empty(),cuLimit:400000,instructions:[new TransactionInstruction({programId:PUMP_PROGRAM_ID,keys,data:BUY_EXACT_QUOTE_IN_V2_D8})],actions:[{kind:'buy',meta:{buyer:b.publicKey.toBase58(),minimumOutputRaw:String(i+1)}}]};if(i===7){d.instructions.push(SystemProgram.transfer({fromPubkey:b.publicKey,toPubkey:tip,lamports:5000}));d.actions.push({kind:'jito-tip',recipient:tip,meta:{lamports:'5000'}});}return {draft:d};});
 const prepared:any={creatorWallet:payer.publicKey.toBase58(),deployment:{mint},token:{},traders:buyers.map(b=>({walletRef:b.publicKey.toBase58(),address:b.publicKey.toBase58()})),traderPlans:plans,launchDraft:{...empty(),cuLimit:600000,instructions:[create],signers:[mint]},expectedOutputByWallet:[]};
 const signers=new Map([payer,...buyers].map(k=>[k.publicKey.toBase58(),k]));return {prepared,signer:(r:any)=>signers.get(String(r))!,buyers,payer};
}
test('eight followers group 3/3/2 with every protected output, signer and final tip preserved',()=>{const f=fixture(),r=groupPumpJitoDrafts(f.prepared,3,f.signer);expect(r.groups.map(g=>g.length)).toEqual([3,3,2]);expect(r.drafts.flatMap(d=>d.actions).filter(a=>a.kind==='buy').map(a=>a.meta?.minimumOutputRaw)).toEqual(['1','2','3','4','5','6','7','8']);expect(r.drafts.map(d=>d.signers.length)).toEqual([3,3,2]);expect(r.drafts.flatMap(d=>d.actions).filter(a=>a.kind==='jito-tip')).toHaveLength(1);expect(r.drafts.at(-1)!.instructions.at(-1)!.keys[0]!.pubkey.equals(f.buyers[7]!.publicKey)).toBe(true);for(const count of [0,4,1.5])expect(()=>groupPumpJitoDrafts(f.prepared,count,f.signer)).toThrow();expect(()=>groupPumpJitoDrafts(f.prepared,1,f.signer)).toThrow('no automatic bundle splitting');});
test('grouped Jito dry run signs one lifetime and simulates all four transactions without sending',async()=>{
 const f=fixture(),hash=PublicKey.default.toBase58(),blockhash={invalidate(){},get:async()=>({blockhash:hash,lastValidBlockHeight:99})};let sent=0;const compiled:any[]=[],requests:any[]=[],events:any[]=[];
 const host:any={signer:f.signer,connection:()=>({}),blockhash,compile:async(payer:any,draft:any,options:any)=>{const plan=await assembleTransaction({connection:{} as any,blockhash:blockhash as any,payer,draft,lifetime:options.lifetime,transactionVersion:1,altAddresses:[]});compiled.push(plan);return plan;},sendBatchPlans:()=>{sent++;throw Error('SEND_FORBIDDEN');},simulatePlan:()=>{throw Error('INDIVIDUAL_SIMULATION_FORBIDDEN');}};
 const originalFetch=globalThis.fetch,originalUrl=process.env.JITO_BUNDLE_SIMULATION_RPC_URL;process.env.JITO_BUNDLE_SIMULATION_RPC_URL='https://example.test/sim';
 globalThis.fetch=(async(_url:any,init:any)=>{const body=JSON.parse(init.body);requests.push(body);return Response.json({result:{context:{slot:1},value:{summary:'succeeded',transactionResults:body.params[0].encodedTransactions.map(()=>({err:null,unitsConsumed:100000}))}}});}) as any;
 try{const result=await executePumpTokenLaunch({slrd:host,prepared:f.prepared,live:false,traderSubmitMode:'jito-bundle',buyersPerTransaction:3,skipSimulation:false,spam:{} as any,kind:'unit',reporter:(label,value)=>events.push({label,value})});expect(events.find(e=>e.label==='pump jito shared blockhash').value.layout[0].buyers).toEqual([]);expect(result.mode).toBe('dry-run');expect(compiled).toHaveLength(8);expect(new Set(compiled.map(p=>p.recentBlockhash)).size).toBe(1);expect(compiled.every(p=>p.transaction.signatures.every((s:Uint8Array)=>s.some(b=>b!==0)))).toBe(true);expect(requests).toHaveLength(2);expect(requests[0].method).toBe('simulateBundle');expect(requests[0].params[0].encodedTransactions).toHaveLength(4);expect(sent).toBe(0);
 }finally{globalThis.fetch=originalFetch;if(originalUrl===undefined)delete process.env.JITO_BUNDLE_SIMULATION_RPC_URL;else process.env.JITO_BUNDLE_SIMULATION_RPC_URL=originalUrl;}
});

import {addVanityMintToPool,reserveVanityMintFromPool,markVanityMintUsed} from './vanity-pool.ts';
test('exact owned vanity reservation resumes without releasing or stealing another reservation',()=>{
 const old=process.env.SLRD_MASTER_KEY;process.env.SLRD_MASTER_KEY='unit-fixture-only';
 let row:any;const db:any={transaction:(fn:any)=>fn(),settings:{select:()=>({where:()=>({first:()=>row})}),insert:(v:any)=>{row=v;}}};
 const mint=Keypair.generate(),suffix=mint.publicKey.toBase58().slice(-2);
 try{addVanityMintToPool(mint,suffix,db);const reserved=reserveVanityMintFromPool(suffix,{address:mint.publicKey.toBase58(),reason:'FAIRS fixture'},db);
 expect(()=>reserveVanityMintFromPool(suffix,{address:reserved.address,resumeReason:'other'},db)).toThrow();
 const resumed=reserveVanityMintFromPool(suffix,{address:reserved.address,resumeReason:'FAIRS fixture'},db);
 expect(resumed.address).toBe(reserved.address);expect(resumed.reservedAtMs).toBe(reserved.reservedAtMs);expect(resumed.mint.publicKey.equals(mint.publicKey)).toBe(true);
 markVanityMintUsed(reserved.address,db);expect(()=>reserveVanityMintFromPool(suffix,{address:reserved.address,resumeReason:'FAIRS fixture'},db)).toThrow();
 }finally{if(old===undefined)delete process.env.SLRD_MASTER_KEY;else process.env.SLRD_MASTER_KEY=old;}
});
