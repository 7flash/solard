import { test, expect } from "bun:test";
import { Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Solard } from "../core/solard.ts";
import { openDatabase, closeDatabase } from "../db/database.ts";
import { ExecutionRepo } from "../db/execution-repo.ts";
import { TradeIntentStore } from "./trade-intent.ts";
import { leasePreparedSubmission, takePreparedSubmission } from "./prepared-submission.ts";
import type { PlannedTransaction } from "./types.ts";
import { buildV1Transaction } from "./wire-transaction.ts";

function signedPlan() {
  const payer = Keypair.generate();
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [] }).compileToV0Message());
  transaction.sign([payer]);
  return { payer, plan: { transaction, payer: payer.publicKey, draft: { instructions: [], actions: [],
    signers: [], trackedAccounts: [], cuLimit: 600000, cuPriceMicroLamports: 20000 }, lookupTables: [],
    serializedSize: transaction.serialize().length, assembledAtMs: Date.now(),
    recentBlockhash: transaction.message.recentBlockhash, lastValidBlockHeight: 100 } as PlannedTransaction };
}

test("prepared preflight is exact-byte, short-lived and single-use", () => {
  const {plan} = signedPlan();
  expect(takePreparedSubmission(plan)).toBeUndefined();
  leasePreparedSubmission(plan, 17000, Date.now());
  expect(takePreparedSubmission(plan)).toBe(17000);
  expect(takePreparedSubmission(plan)).toBeUndefined();
  leasePreparedSubmission(plan, 17000, Date.now()-5001);
  expect(() => takePreparedSubmission(plan)).toThrow("expired or changed");
  leasePreparedSubmission(plan, 17000, Date.now());
  plan.transaction.signatures[0]![0] ^= 1;
  expect(() => takePreparedSubmission(plan)).toThrow("expired or changed");
});

for (const version of [0,1] as const) for (const side of ["buy", "sell"] as const) test(`prepared v${version} ${side}: real submission journals bytes before send with zero preparation RPCs at trigger`, async () => {
  const path=join(mkdtempSync(join(tmpdir(),"prepared-order-")),"db.sqlite");
  const db=openDatabase(path);
  try {
    const {payer,plan}=signedPlan(), core=Object.create(Solard.prototype) as Solard;
    if (version===1) {
      plan.transaction=await buildV1Transaction(payer.publicKey,plan.draft,plan.recentBlockhash,plan.lastValidBlockHeight);
      await plan.transaction.sign([payer],plan.lastValidBlockHeight);
    }
    const executions=new ExecutionRepo(db), intent=new TradeIntentStore(db);
    Object.defineProperties(core,{db:{value:db},dbPath:{value:path},executions:{value:executions},
      senders:{value:{resolve:()=>({send:async({transaction,options}:any)=>{
        calls.push("send"); expect(options.skipPreflight).toBe(true);
        const row=intent.get("limit-order")!.submissions[0]!;
        const record=executions.get(row.executionId)!;
        expect(JSON.parse(record.metaJson!).signedTransactionBase64).toBe(Buffer.from(transaction.serialize()).toString("base64"));
        return row.signature;
      }})}}});
    const calls:string[]=[];
    core.signer=()=>payer;
    core.connection=(()=>({
      getBalance:async()=>{calls.push("balance");return 1000000000;},
      getFeeForMessage:async()=>{calls.push("fee");return {value:17000};},
    })) as any;
    const composition:any[]=[];
    const composer:any={prepareLimitOrder:(limit:any)=>{composition.push(limit);return composer;},buy:(_token:any,_amount:any,options:any)=>{composition.push(options);calls.push("buy-build");return composer;},
      sell:(_token:any,options:any)=>{composition.push(options);calls.push("sell-build");return composer;},build:async()=>plan};
    core.tx=(()=>composer) as any;
    core.prepareTradePlan=async()=>({plan,priorityMicroLamports:20000});
    core.compile=async(_signer,draft)=>{
      calls.push("refresh-compile");
      if (version===1) {
        const recentBlockhash=Keypair.generate().publicKey.toBase58();
        const transaction=await buildV1Transaction(payer.publicKey,draft,recentBlockhash,100);
        await transaction.sign([payer],100);
        return {...plan,draft,transaction,recentBlockhash,assembledAtMs:Date.now()};
      }
      const transaction=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,
        recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[]}).compileToV0Message());
      transaction.sign([payer]);
      return {...plan,draft,transaction,recentBlockhash:transaction.message.recentBlockhash,assembledAtMs:Date.now()};
    };
    core.simulatePlan=async()=>{throw Error("Per-trigger simulation must not run");};
    core.settleSubmission=async(submission)=>({signature:submission.signature,status:"confirmed",sender:"rpc",slot:1,
      solPrincipalDeltaLamports:side==="buy"?-100000000n:100000000n,
      targetTokenDeltaRaw:side==="buy"?100n:-100n,networkFeeLamports:17000n});
    const prepared=await core.prepareFastTrade({side,wallet:"wallet",token:payer.publicKey.toBase58(),
      ...(side==="buy"?{amountSol:"0.1"}:{amountRaw:"100"}),priceSol:"0.001",
      ...(version===1?{priceKind:"spot" as const,additionalSlippageBps:74}:{})});
    if(version===1){
      expect(composition[0]).toEqual({priceSol:"0.001",additionalSlippageBps:74});
      expect(composition[1].slippageBps).toBe(74);
      expect(composition[1].maxPriceSol).toBeUndefined();expect(composition[1].minPriceSol).toBeUndefined();
    }
    expect(calls).toEqual([`${side}-build`,"balance","fee"]);
    calls.length=0;
    const refreshed=await prepared.refresh();
    expect(calls).toEqual(["refresh-compile","balance","fee"]);
    expect((await prepared.execute({intentKey:"superseded"})).code).toBe("PREPARATION_CONSUMED");
    expect(intent.get("superseded")).toBeNull();
    calls.length=0;
    const start=performance.now();
    const result=await refreshed.execute({intentKey:"limit-order"});
    expect(result.status).toBe("confirmed");
    expect(calls).toEqual(["send"]);
    expect(performance.now()-start).toBeLessThan(1000);
    expect((await refreshed.execute({intentKey:"another"})).code).toBe("PREPARATION_CONSUMED");
    await expect(refreshed.refresh()).rejects.toMatchObject({code:"PREPARATION_EXPIRED"});
    expect(calls).toEqual(["send"]);
    const cancelled=await core.prepareFastTrade({side,wallet:"wallet",token:payer.publicKey.toBase58(),
      ...(side==="buy"?{amountSol:"0.1"}:{amountRaw:"100"}),priceSol:"0.001"});
    const abort=new AbortController();abort.abort();calls.length=0;
    expect((await cancelled.execute({intentKey:"cancelled",signal:abort.signal})).code).toBe("ORDER_CANCELLED");
    expect(intent.get("cancelled")!.submissions).toHaveLength(0);
    expect(calls).toEqual([]);
  } finally {closeDatabase(path);}
});

test("prepared spot allowance above 2% or missing rejects before signing or route access",async()=>{
  const core=Object.create(Solard.prototype) as Solard;
  core.tx=()=>{throw Error("Route must not be accessed");};
  for(const additionalSlippageBps of [201,-1,NaN,undefined]){
    await expect(core.prepareFastTrade({side:"buy",wallet:"wallet",token:"token",amountSol:"0.1",priceSol:"1",
      priceKind:"spot",additionalSlippageBps})).rejects.toThrow("0..200");
  }
});
