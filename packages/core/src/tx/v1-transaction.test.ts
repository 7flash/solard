import { expect, test } from "bun:test";
import { Keypair, PublicKey, TransactionInstruction, SystemProgram, Connection, ComputeBudgetProgram } from "@solana/web3.js";
import { VersionedTransaction as NativeTransaction } from "@solana/web3-v1";
import { assembleTransaction } from "./assemble.ts";
import { deserializeWireTransaction } from "./wire-transaction.ts";
import { simulatePlanned } from "../chain/simulate.ts";
import { estimatePlanFee } from "./fee-estimate.ts";
import { RpcSender } from "./senders/rpc-sender.ts";
import type { TransactionDraft } from "./types.ts";
const payer=Keypair.generate(), mint=Keypair.generate();
const blockhash={get:async()=>({blockhash:PublicKey.default.toBase58(),lastValidBlockHeight:100})} as any;
const draft:TransactionDraft={instructions:[new TransactionInstruction({programId:SystemProgram.programId,
  keys:[{pubkey:mint.publicKey,isSigner:true,isWritable:true}],data:Buffer.alloc(1500)})],
  signers:[mint],actions:[{kind:"buy",meta:{minOutputRaw:"99"}}],trackedAccounts:[],cuLimit:200000,cuPriceMicroLamports:30001};
const base={connection:{} as Connection,blockhash,draft,altAddresses:[],transactionVersion:1 as const};
test("v1 signs >1232 byte plans with native codec, config fees, both signers and no ALT reads",async()=>{
 const plan=await assembleTransaction({...base,payer});
 expect(plan.transaction.version).toBe(1);expect(plan.serializedSize).toBeGreaterThan(1232);expect(plan.serializedSize).toBeLessThanOrEqual(4096);
 expect(plan.lookupTables).toEqual([]);expect(plan.transaction.serialize()[0]).toBe(0x81);
 const native=NativeTransaction.deserialize(plan.transaction.serialize());
 expect(native.version).toBe(1);expect(native.message.compiledInstructions).toHaveLength(1);
 expect(plan.transaction.signatures).toHaveLength(2);expect(plan.transaction.signatures.every(s=>s.some(v=>v!==0))).toBe(true);
 const key=await crypto.subtle.importKey("raw",new Uint8Array(payer.publicKey.toBytes()).buffer,{name:"Ed25519"},false,["verify"]);
 expect(await crypto.subtle.verify("Ed25519",key,new Uint8Array(plan.transaction.signatures[0]!).buffer,new Uint8Array(native.message.serialize()).buffer)).toBe(true);
 expect('transactionConfig' in native.message && native.message.transactionConfig).toMatchObject({computeUnitLimit:200000,loadedAccountsDataSizeLimit:67108864,priorityFeeLamports:6001n});
 expect(deserializeWireTransaction(plan.transaction.serialize()).serialize()).toEqual(plan.transaction.serialize());
 expect(plan.draft.actions[0]?.meta?.minOutputRaw).toBe("99");
});
test("unsigned v1 retains zero signatures; oversize and resource instruction errors reject",async()=>{
 const plan=await assembleTransaction({...base,payer:payer.publicKey,unsigned:true});
 expect(plan.transaction.signatures.every(s=>s.every(v=>v===0))).toBe(true);
 await expect(assembleTransaction({...base,payer,draft:{...draft,instructions:[new TransactionInstruction({programId:SystemProgram.programId,keys:[],data:Buffer.alloc(4100)})]}})).rejects.toMatchObject({code:"TRANSACTION_TOO_LARGE"});
 await expect(assembleTransaction({...base,payer,draft:{...draft,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1})]}})).rejects.toThrow("transaction config");
});
test("existing RPC simulation, fee and sender paths transmit native v1 bytes over base64",async()=>{
 const seen:any[]=[];
 const signature="1".repeat(64);
 const connection=new Connection("http://127.0.0.1:8899",{fetch:(async(_url,init)=>{
   const body=JSON.parse(String(init?.body));seen.push(body);
   const result=body.method==='simulateTransaction'?{context:{slot:1},value:{err:null,logs:[],unitsConsumed:1000,accounts:[]}}
     :body.method==='getFeeForMessage'?{context:{slot:1},value:16001}:signature;
   return Response.json({jsonrpc:'2.0',id:body.id,result});
 }) as typeof fetch});
 const plan=await assembleTransaction({...base,connection,payer});
 expect((await simulatePlanned(connection,plan)).success).toBe(true);
 expect((await estimatePlanFee(connection,plan)).estimatedNetworkFeeLamports).toBe(16001);
 expect(await new RpcSender().send({connection,transaction:plan.transaction,options:{skipPreflight:false}})).toBe(signature);
 for(const method of ['simulateTransaction','sendTransaction']){
  const call=seen.find(x=>x.method===method);expect(call.params[1].encoding).toBe('base64');
  const bytes=Buffer.from(call.params[0],'base64');expect(bytes[0]).toBe(0x81);expect(NativeTransaction.deserialize(bytes).version).toBe(1);
 }
 expect(seen.find(x=>x.method==='sendTransaction').params[1].skipPreflight === true).toBe(false);
 expect(Buffer.from(seen.find(x=>x.method==='getFeeForMessage').params[0],'base64')[0]).toBe(0x81);
});
