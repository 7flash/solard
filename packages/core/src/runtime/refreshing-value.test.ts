import { test, expect } from "bun:test";
import { RefreshingValue } from "./refreshing-value.ts";
import { marketCapPrices } from "./market-cap-band.ts";
import { fixedPriceSignal } from "./fixed-price-band.ts";

test("slow supply refresh cannot block a sell decision with valid verified metadata", async () => {
  let now=1000, calls=0, finish!: (value: { supply: bigint; decimals: number; atMs: number })=>void;
  const original={supply:1000000000000000n,decimals:6,atMs:now};
  const cache=new RefreshingValue(async()=>{calls++;return calls===1?original:await new Promise<typeof original>(resolve=>{finish=resolve;});},
    {refreshAfterMs:45000,maxAgeMs:120000,now:()=>now});
  expect(cache.get()).toBeUndefined();await Bun.sleep(0);
  expect(cache.get()).toEqual(original);
  now=47000;
  const supply=cache.get()!;await Bun.sleep(0);expect(calls).toBe(2);
  const band=marketCapPrices({kind:'market-cap',buyMarketCapUsd:'14000',sellMarketCapUsd:'20000'},supply,{price:100,atMs:now},now);
  expect(fixedPriceSignal('sell',0.00000021,band)).toBe('sell');
  // The pending refresh has not resolved; repeated decisions do not await it.
  expect(cache.get()).toEqual(original);expect(calls).toBe(2);
  now=122000;expect(cache.get()).toBeUndefined(); // Same 120s validity bound.
  finish({...original,atMs:now});await Bun.sleep(0);expect(cache.get()?.atMs).toBe(now);
});

test("failed refresh retains original freshness, cools down, rejects stale and stops after close", async () => {
  let now=1000,calls=0,failed=false;
  const cache=new RefreshingValue(async()=>{calls++;if(failed)throw Error('quota');return {atMs:1000};},
    {refreshAfterMs:45000,maxAgeMs:120000,now:()=>now});
  cache.get();await Bun.sleep(0);failed=true;now=47000;cache.get();await Bun.sleep(0);
  expect(cache.get()?.atMs).toBe(1000);expect(calls).toBe(2);
  now=122000;expect(cache.get()).toBeUndefined();await Bun.sleep(0);
  cache.close();const count=calls;now+=10000;expect(cache.get()).toBeUndefined();await Bun.sleep(0);expect(calls).toBe(count);
});

test("old shared USD cache cannot cause repeated refresh wakeups or invented fresh timestamps", async () => {
  let now=47000,calls=0;
  const cache=new RefreshingValue(async()=>{calls++;return {atMs:1000};},{refreshAfterMs:45000,maxAgeMs:120000,now:()=>now});
  cache.get();await Bun.sleep(0);
  for(let i=0;i<10;i++)cache.get();await Bun.sleep(0);expect(calls).toBe(1);expect(cache.get()?.atMs).toBe(1000);
  now=122000;expect(cache.get()).toBeUndefined();await Bun.sleep(0);expect(cache.get()).toBeUndefined();
});
