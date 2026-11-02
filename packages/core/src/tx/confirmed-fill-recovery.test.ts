import { test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Keypair } from "@solana/web3.js";
import { openDatabase, closeDatabase } from "../db/database.ts";
import { ExecutionRepo } from "../db/execution-repo.ts";
import { TradeIntentStore } from "./trade-intent.ts";
import { Solard } from "../core/solard.ts";
import { tradeResult } from "./trade-result.ts";

test("confirmed intent retries only v1 metadata and durably recovers original fill including rent", async () => {
  const path=join(mkdtempSync(join(tmpdir(),"confirmed-fill-")),"db.sqlite");
  const db=openDatabase(path), owner=Keypair.generate().publicKey.toBase58(), mint=Keypair.generate().publicKey.toBase58();
  try {
    const executions=new ExecutionRepo(db), store=new TradeIntentStore(db);
    const execution=executions.create({kind:"buy",status:"confirmed",signature:"original",walletAddress:owner,mint,
      sender:"rpc",venue:"pump-curve",slot:1,error:null,metaJson:null});
    store.claim("confirmed","same",owner);
    store.update("confirmed",row=>{
      row.submissions.push({executionId:execution.id,signature:"original",sender:"rpc",lastValidBlockHeight:1,priorityMicroLamports:0});
      row.result=tradeResult({signature:"original",sender:"rpc",status:"confirmed",slot:1});
    });
    const core=Object.create(Solard.prototype) as Solard;
    Object.defineProperties(core,{db:{value:db},executions:{value:executions}});
    let available=false, reads=0;
    core.connection=(()=>({getParsedTransaction:async(signature:string,config:any)=>{
      reads++; expect(signature).toBe("original");expect(config.maxSupportedTransactionVersion).toBe(1);
      if(!available)return null;
      return {version:1,blockTime:1,transaction:{message:{accountKeys:[{pubkey:owner},{pubkey:"ata"}]}},meta:{err:null,
        fee:5000,preBalances:[1000000000,0],postBalances:[897955720,2039280],preTokenBalances:[],
        postTokenBalances:[{owner,mint,accountIndex:1,uiTokenAmount:{amount:"1000000",decimals:6}}]}};
    }})) as any;
    core.signer=()=>{throw Error("Must never access signer");};
    core.confirmSignature=()=>{throw Error("Must not resubmit or reconfirm a known confirmation");};
    expect((await core.resumeTrade("confirmed")).targetTokenDeltaRaw).toBeNull();
    available=true;
    const result=await core.resumeTrade("confirmed");
    expect(result).toMatchObject({status:"confirmed",signature:"original",targetTokenDeltaRaw:1000000n,
      solPrincipalDeltaLamports:-100000000n,networkFeeLamports:5000n});
    expect(store.get("confirmed")?.result?.targetTokenDeltaRaw).toBe(1000000n);
    expect((await core.resumeTrade("confirmed")).signature).toBe("original");expect(reads).toBe(2);
  } finally { closeDatabase(path); }
});
