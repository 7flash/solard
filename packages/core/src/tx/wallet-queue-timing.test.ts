import { test, expect } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { Solard } from "../core/solard.ts";
import { tradeResult } from "./trade-result.ts";
test("wallet queue delay is reported independently and callbacks cannot break ordering",async()=>{
 const core=Object.create(Solard.prototype) as Solard,payer=Keypair.generate();core.signer=()=>payer;
 let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
 const order:string[]=[],stages:Array<{stage:string;ms:number}>=[];
 const receipt=()=>tradeResult({signature:'original',status:'confirmed',sender:'rpc',slot:1});
 const first=core.runReliableTrade('wallet',undefined,'first',async()=>{order.push('first');await blocked;return receipt();});
 const second=core.runReliableTrade('wallet',undefined,'second',async()=>{order.push('second');return receipt();},
   {onStage:(stage,ms)=>{stages.push({stage,ms});throw Error('UI callback failure');}});
 await Bun.sleep(15);expect(order).toEqual(['first']);expect(stages).toHaveLength(0);
 release();await Promise.all([first,second]);
 expect(order).toEqual(['first','second']);expect(stages).toHaveLength(1);
 expect(stages[0]!.stage).toBe('wallet-queue');expect(stages[0]!.ms).toBeGreaterThanOrEqual(10);
});
