import { test, expect, spyOn } from "bun:test";
import { Keypair, type Connection } from "@solana/web3.js";
import { recentTradeFees } from "./recent-trade-fees.ts";
import { Solard } from "../core/solard.ts";
import { solardRpcFetch } from "../chain/connection.ts";

test("hung fee read is bounded, coalesced and later fills a defensive cache", async () => {
  let finish!: (rows: any[]) => void, calls=0;
  const connection={getRecentPrioritizationFees:()=>{calls++;return new Promise<any[]>(resolve=>{finish=resolve;});}} as unknown as Connection;
  const start=performance.now();
  expect(await recentTradeFees(connection,[],10)).toEqual([]);
  expect(performance.now()-start).toBeLessThan(1000);
  expect(await recentTradeFees(connection,[],10)).toEqual([]);expect(calls).toBe(1);
  finish([{prioritizationFee:20},{prioritizationFee:-1},{prioritizationFee:NaN}]);
  await Bun.sleep(0);
  const samples=await recentTradeFees(connection,[],10);expect(samples).toEqual([20]);
  samples.push(999);expect(await recentTradeFees(connection,[],10)).toEqual([20]);expect(calls).toBe(1);
});

test("fee provider failure is cooled down and account-scoped cache does not leak", async () => {
  let calls=0;
  const connection={getRecentPrioritizationFees:async()=>{calls++;throw Error('429');}} as unknown as Connection;
  const address=Keypair.generate().publicKey;
  expect(await recentTradeFees(connection,[address])).toEqual([]);
  expect(await recentTradeFees(connection,[address])).toEqual([]);expect(calls).toBe(1);
  await recentTradeFees(connection,[Keypair.generate().publicKey]);expect(calls).toBe(2);
});

test("actual plan fee preparation proceeds with its capped floor during a hung provider; fixed bids make no lookup", async () => {
  const core=Object.create(Solard.prototype) as Solard, payer=Keypair.generate();let calls=0;
  const connection={getRecentPrioritizationFees:()=>{calls++;return new Promise(()=>{});}} as unknown as Connection;
  core.connection=()=>connection;core.signer=()=>payer;
  const plan:any={payer:payer.publicKey,draft:{instructions:[],actions:[],trackedAccounts:[],signers:[],cuLimit:200000}};
  core.compile=async(_payer,draft)=>({...plan,draft});
  const start=performance.now();
  const prepared=await core.prepareTradePlan('wallet',plan,{landing:{maxPriorityFeeLamports:10000}});
  expect(performance.now()-start).toBeLessThan(1500);
  expect(prepared.priorityMicroLamports).toBe(50000);expect(calls).toBe(1);
  const fixed=await core.prepareTradePlan('wallet',plan,{landing:{microLamports:20}});
  expect(fixed.priorityMicroLamports).toBe(20);expect(calls).toBe(1);
});

test("optional fee RPC 429 makes only one transport attempt", async () => {
  let calls=0;const fetch=spyOn(globalThis,'fetch').mockImplementation((async()=>{calls++;return new Response('',{status:429});}) as unknown as typeof globalThis.fetch);
  try {
    const response=await solardRpcFetch('https://fee-test.example/',{method:'POST',body:JSON.stringify({method:'getRecentPrioritizationFees',params:[]})},{poolScheduled:true});
    expect(response.status).toBe(429);expect(calls).toBe(1);
  } finally { fetch.mockRestore(); }
});
