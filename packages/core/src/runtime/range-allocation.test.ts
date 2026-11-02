import {expect,test} from 'bun:test';
import {initialAllocation,adoptedAllocation,allocationOrder,validateAllocation,reconcileAllocationInventory,reanchorAllocation} from './range-allocation.ts';
import {settleLadder,type LadderConfig} from './bid-ask-ladder.ts';
const c:LadderConfig={lowerCap:364000,upperCap:611000,stepBps:1000,portionBps:500,budgetLamports:'100000000',sizing:'fixed',bounds:'allocate'};
test('range allocation enters half at midpoint and more tokens near the bottom',()=>{
 expect(allocationOrder(c,initialAllocation(c,487500,1),'buy')!.amountRaw).toBe('50000000');
 expect(allocationOrder(c,initialAllocation(c,388700,1),'buy')!.amountRaw).toBe('90000000');
 expect(allocationOrder(c,initialAllocation(c,364000,1),'buy')!.amountRaw).toBe('100000000');
 expect(()=>initialAllocation(c,611000,1)).toThrow();
 expect(()=>initialAllocation(c,881000,1)).toThrow();
});
test('steps use range width and recalculate managed value; confirmed fills alone advance',()=>{
 const seed=initialAllocation(c,487500,1),entry=allocationOrder(c,seed,'buy')!;
 const state=settleLadder(seed,entry,{solPrincipalDeltaLamports:'-50000000',targetTokenDeltaRaw:'50000000',networkFeeLamports:'17000'}) as typeof seed;
 const up=allocationOrder(c,state,'sell')!,down=allocationOrder(c,state,'buy')!;
 expect(up.cap).toBe(512200);expect(down.cap).toBe(462800);
 expect(BigInt(up.amountRaw)).toBeGreaterThan(0n);expect(up.amountRaw).not.toBe('50000000');
 expect(state.bin).toBe(5);expect(seed.initialized).toBe(false);
 const after=settleLadder(state,up,{solPrincipalDeltaLamports:String(Math.floor(Number(up.amountRaw)*512200/487500)),targetTokenDeltaRaw:String(-BigInt(up.amountRaw)),networkFeeLamports:'17000'}) as typeof seed;
 expect(after.bin).toBe(6);expect(allocationOrder(c,after,'buy')!.cap).toBe(487500);
 expect(after.rawUnitLamports).toBe(1);
});
test('top sells exactly managed tokens, lower endpoint spends only managed cash',()=>{
 const state={...initialAllocation(c,487500,1),initialized:true,bin:9,cashLamports:'70000000',tokenRaw:'123456789012345'};
 expect(allocationOrder(c,state,'sell')!.amountRaw).toBe(state.tokenRaw);
 expect(allocationOrder(c,{...state,bin:1},'buy')!.amountRaw).toBe(state.cashLamports);
 expect(allocationOrder(c,{...state,bin:10},'sell')).toBeNull();
 expect(allocationOrder(c,{...state,bin:0},'buy')).toBeNull();
});
test('100% range step is the endpoint-only full buy/sell case',()=>{
 const full={...c,stepBps:10000};validateAllocation(full);
 const state={...initialAllocation(full,487500,1),initialized:true,tokenRaw:'100',cashLamports:'100'};
 expect(allocationOrder(full,state,'sell')).toMatchObject({cap:611000,amountRaw:'100'});
 expect(allocationOrder(full,state,'buy')).toMatchObject({cap:364000,amountRaw:'100'});
 expect(()=>validateAllocation({...c,stepBps:3000})).toThrow();
});
test('adopted tokens rebalance without allocating new SOL and preserve nonnegative inventory',()=>{
 const state=adoptedAllocation(c,487500,1,'100000000');
 expect(allocationOrder(c,state,'buy')).toBeNull();
 const sell=allocationOrder(c,state,'sell')!;expect(sell.amountRaw).toBe('50000000');
 const next=settleLadder(state,sell,{solPrincipalDeltaLamports:'50000000',targetTokenDeltaRaw:'-50000000',networkFeeLamports:'17000'});
 expect(next.cashLamports).toBe('50000000');expect(next.tokenRaw).toBe('50000000');expect(next.initialTokenRaw).toBe('50000000');
 expect(allocationOrder(c,adoptedAllocation(c,700000,1,'100'),'sell')!.amountRaw).toBe('100');
 expect(allocationOrder(c,adoptedAllocation(c,300000,1,'100'),'sell')!.cap).toBe(388700);
});
test('finalized external inventory reconciliation preserves cash and fees without inventing a fill',()=>{
 const before={...adoptedAllocation(c,487500,1,'100000000'),initialized:true,cashLamports:'1000',feesLamports:'17000'};
 const after=reconcileAllocationInventory(c,before,'200000000');
 expect(after.tokenRaw).toBe('200000000');expect(after.cashLamports).toBe('1000');expect(after.feesLamports).toBe('17000');
 expect(after.initialized).toBe(false);expect(before.tokenRaw).toBe('100000000');
 expect(reconcileAllocationInventory(c,before,'0').cashLamports).toBe('1000');
 const fresh=reanchorAllocation(c,after,512200,2);
 expect(fresh.anchorCap).toBe(512200);expect(fresh.rawUnitLamports).toBe(2);expect(fresh.bin).toBe(6);
 expect(fresh.tokenRaw).toBe('200000000');expect(fresh.cashLamports).toBe('1000');
});
