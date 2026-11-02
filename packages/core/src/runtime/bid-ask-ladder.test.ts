import {expect,test} from "bun:test";
import {initialLadder,ladderOrder,ladderEligible,ladderLevel,settleLadder,validateLadder,type LadderConfig} from "./bid-ask-ladder.ts";
const config:LadderConfig={lowerCap:200000,upperCap:300000,stepBps:500,portionBps:500,
  budgetLamports:"100000000",sizing:"fixed",bounds:"pause"};
const seed=()=>initialLadder(config,250000);
const filled=()=>settleLadder(seed(),ladderOrder(config,seed(),"buy")!,{
  solPrincipalDeltaLamports:"-50000000",targetTokenDeltaRaw:"200000000000",networkFeeLamports:"17000"});
test("initial entry spends half once and uses actual raw fill, not estimated inventory",()=>{
  const state=seed(),order=ladderOrder(config,state,"buy")!;
  expect(order.amountRaw).toBe("50000000");expect(ladderOrder(config,state,"sell")).toBeNull();
  const next=filled();expect(next.cashLamports).toBe("50000000");expect(next.tokenRaw).toBe("200000000000");
  expect(next.initialTokenRaw).toBe(next.tokenRaw);expect(next.feesLamports).toBe("17000");expect(state.initialized).toBe(false);
});
test("5% bins match the example; fixed buy and sell portions are 1/20 of initial allocations",()=>{
  const state=filled(),sell=ladderOrder(config,state,"sell")!,buy=ladderOrder(config,state,"buy")!;
  expect(sell.cap).toBe(262500);expect(sell.amountRaw).toBe("10000000000");
  expect(buy.cap).toBe(237500);expect(buy.amountRaw).toBe("2500000");
  expect(ladderEligible(config,sell,262499)).toBe(false);expect(ladderEligible(config,sell,262500)).toBe(true);
  expect(ladderEligible(config,buy,237501)).toBe(false);expect(ladderEligible(config,buy,237500)).toBe(true);
});
test("a confirmed sell advances one anchored level; oscillation within its bin does not repeat it",()=>{
  const before=filled(),order=ladderOrder(config,before,"sell")!;
  const after=settleLadder(before,order,{solPrincipalDeltaLamports:"2625000",targetTokenDeltaRaw:"-10000000000",networkFeeLamports:"17000"});
  expect(after.bin).toBe(1);expect(after.cashLamports).toBe("52625000");expect(after.tokenRaw).toBe("190000000000");
  expect(ladderOrder(config,after,"buy")!.cap).toBe(250000);
  expect(ladderEligible(config,ladderOrder(config,after,"sell")!,262500)).toBe(false);
  expect(ladderOrder(config,after,"sell")!.amountRaw).toBe(order.amountRaw);
});
test("a down/up round trip returns to the same anchor instead of multiplying by .95 then 1.05",()=>{
  const state=filled(),buy=ladderOrder(config,state,"buy")!;
  const after=settleLadder(state,buy,{solPrincipalDeltaLamports:"-2500000",targetTokenDeltaRaw:"10526315789",networkFeeLamports:"17000"});
  expect(after.bin).toBe(-1);expect(ladderOrder(config,after,"sell")!.cap).toBe(250000);
});
test("remaining mode recalculates from managed inventory only",()=>{
  const state={...filled(),tokenRaw:"190000000000",cashLamports:"47500000"};
  const c={...config,sizing:"remaining" as const};
  expect(ladderOrder(c,state,"sell")!.amountRaw).toBe("9500000000");
  expect(ladderOrder(c,state,"buy")!.amountRaw).toBe("2375000");
});
test("partial final steps never consume inventory outside the managed budget",()=>{
  const state={...filled(),cashLamports:"9",tokenRaw:"3"};
  expect(ladderOrder(config,state,"buy")!.amountRaw).toBe("9");expect(ladderOrder(config,state,"sell")!.amountRaw).toBe("3");
  expect(ladderOrder(config,{...state,tokenRaw:"0"},"sell")).toBeNull();
  expect(ladderOrder(config,{...state,cashLamports:"0"},"buy")).toBeNull();
});
test("pause bounds reject price jumps outside range, including initial orders",()=>{
  const state=filled();for(const cap of [199999,300001,NaN,Infinity,0]){
    expect(ladderEligible(config,ladderOrder(config,state,"buy")!,cap)).toBe(false);
    expect(ladderEligible(config,ladderOrder(config,state,"sell")!,cap)).toBe(false);
  }
  expect(ladderOrder(config,{...state,bin:3},"sell")).toBeNull();
  expect(ladderOrder(config,{...state,bin:-4},"buy")).toBeNull();
});
test("explicit boundary allocation sells all or spends only remaining cash, preserving resumable bins",()=>{
  const c={...config,bounds:"allocate" as const},state=filled();
  const sell=ladderOrder(c,state,"sell",310000)!;
  expect(sell.kind).toBe("boundary");expect(sell.cap).toBe(300000);expect(sell.amountRaw).toBe(state.tokenRaw);expect(sell.bin).toBe(3);
  const buy=ladderOrder(c,state,"buy",190000)!;
  expect(buy.cap).toBe(200000);expect(buy.amountRaw).toBe(state.cashLamports);expect(buy.bin).toBe(-4);
});
test("confirmation lacking accounting cannot release the original order or alter state",()=>{
  const state=filled(),order=ladderOrder(config,state,"sell")!,before=JSON.stringify(state);
  expect(()=>settleLadder(state,order,{solPrincipalDeltaLamports:null,targetTokenDeltaRaw:"-10000000000",networkFeeLamports:"17000"})).toThrow("incomplete");
  expect(JSON.stringify(state)).toBe(before);
});
test("mismatched or overspent fills fail closed without mutating inventory",()=>{
  const state=filled(),sell=ladderOrder(config,state,"sell")!,buy=ladderOrder(config,state,"buy")!;
  expect(()=>settleLadder(state,sell,{solPrincipalDeltaLamports:"1",targetTokenDeltaRaw:"-10000000001",networkFeeLamports:"1"})).toThrow("allocation");
  expect(()=>settleLadder(state,buy,{solPrincipalDeltaLamports:"-2500001",targetTokenDeltaRaw:"1",networkFeeLamports:"1"})).toThrow("allocation");
  expect(()=>settleLadder({...state,tokenRaw:"0"},sell,{solPrincipalDeltaLamports:"1",targetTokenDeltaRaw:"-10000000000",networkFeeLamports:"1"})).toThrow("inventory");
});
test("durable JSON round trips preserve very large raw token balances exactly",()=>{
  const state={...filled(),tokenRaw:"900719925474099312345678",initialTokenRaw:"900719925474099312345678"};
  const restored=JSON.parse(JSON.stringify(state));expect(ladderOrder(config,restored,"sell")!.amountRaw).toBe("45035996273704965617283");
});
test("invalid or unbounded configurations reject before any trade",()=>{
  for(const patch of [{stepBps:0},{stepBps:5001},{portionBps:0},{upperCap:200000},{budgetLamports:"1"},{sizing:"unknown"},{bounds:"unknown"},
    {lowerCap:1,upperCap:1e12,stepBps:1}])expect(()=>validateLadder({...config,...patch} as LadderConfig)).toThrow();
  expect(()=>initialLadder(config,199999)).toThrow("inside");expect(()=>ladderLevel(config,filled(),1002)).toThrow("bin");
});
