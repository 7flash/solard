import { test, expect } from "bun:test";
import { PreparedOrderSlot } from "./prepared-order-slot.ts";

test("range edits, position changes, expiry and single consumption invalidate readiness",async()=>{
  let key:string|undefined="buy:0.1:max20",now=0;
  const slot=new PreparedOrderSlot(()=>key,async()=>({expiresAt:100}),()=>now);
  await slot.refresh(); key="buy:0.1:max19";
  expect(slot.take("buy:0.1:max20")).toBeUndefined();
  await slot.refresh();now=101;expect(slot.take(key)).toBeUndefined();
  now=0;await slot.refresh();expect(slot.take(key)).toEqual({expiresAt:100});
  expect(slot.take(key)).toBeUndefined();
  await slot.refresh(); key="sell:123:min25";
  expect(slot.take("buy:0.1:max19")).toBeUndefined();
  await slot.refresh();key=undefined;expect(slot.take("sell:123:min25")).toBeUndefined();
});

test("in-flight preparation cannot reinstall a consumed or changed order; refresh coalesces",async()=>{
  let key:string|undefined="sell:100:min30",finish!:(value:{expiresAt:number})=>void,calls=0;
  const slot=new PreparedOrderSlot(()=>key,()=>{calls++;return new Promise<{expiresAt:number}>(resolve=>{finish=resolve;});});
  const first=slot.refresh(),second=slot.refresh();await Promise.resolve();
  expect(calls).toBe(1);slot.invalidate();finish({expiresAt:Date.now()+1000});
  await Promise.all([first,second]);expect(slot.take(key)).toBeUndefined();
  const third=slot.refresh();await Promise.resolve();key="sell:99:min31";
  finish({expiresAt:Date.now()+1000});await third;expect(slot.take(key)).toBeUndefined();
});
