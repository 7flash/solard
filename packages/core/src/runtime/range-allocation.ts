import type {LadderConfig,LadderState,LadderOrder} from './bid-ask-ladder.ts';

export type AllocationState=LadderState & {rawUnitLamports:number};
export function reanchorAllocation(c:LadderConfig,s:AllocationState,cap:number,unit:number):AllocationState{
 const seed=adoptedAllocation(c,cap,unit,BigInt(s.tokenRaw)>0n?s.tokenRaw:'1');
 return {...s,anchorCap:cap,rawUnitLamports:unit,bin:seed.bin,initialized:false};
}
export function reconcileAllocationInventory(c:LadderConfig,s:AllocationState,raw:string):AllocationState{
 validateAllocation(c);if(!/^\d+$/.test(raw)||BigInt(raw)>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Invalid finalized inventory');
 // External inventory is a contribution/withdrawal, never a synthetic trade or cash receipt.
 return {...s,tokenRaw:raw,initialTokenRaw:raw,initialized:false};
}
export function adoptedAllocation(c:LadderConfig,cap:number,unit:number,tokenRaw:string):AllocationState{
 validateAllocation(c);
 if(!Number.isFinite(cap)||cap<=0||!Number.isFinite(unit)||unit<=0||BigInt(tokenRaw)<=0n)throw Error('Verified positive adoption required');
 const bounded=Math.max(c.lowerCap,Math.min(c.upperCap,cap));
 return {anchorCap:cap,bin:(bounded-c.lowerCap)/(c.upperCap-c.lowerCap)*10000/c.stepBps,initialized:cap<=c.lowerCap,
  cashLamports:'0',tokenRaw,initialTokenRaw:tokenRaw,initialCashLamports:'0',feesLamports:'0',rawUnitLamports:unit};
}
export function validateAllocation(c:LadderConfig){
  if(!Number.isFinite(c.lowerCap)||!Number.isFinite(c.upperCap)||c.lowerCap<=0||c.upperCap<=c.lowerCap||
    !Number.isInteger(c.stepBps)||c.stepBps<100||c.stepBps>10000||10000%c.stepBps!==0||
    !/^\d+$/.test(c.budgetLamports)||BigInt(c.budgetLamports)<2n||BigInt(c.budgetLamports)>BigInt(Number.MAX_SAFE_INTEGER))
    throw Error('Allocation requires increasing bounds, an exact range subdivision and a safe SOL budget');
}
export function initialAllocation(c:LadderConfig,cap:number,rawUnitLamports:number):AllocationState{
  validateAllocation(c);
  if(!Number.isFinite(cap)||cap<c.lowerCap||cap>=c.upperCap||!Number.isFinite(rawUnitLamports)||rawUnitLamports<=0)
    throw Error('Allocation entry must be below the upper bound with verified price');
  return {anchorCap:cap,bin:(cap-c.lowerCap)/(c.upperCap-c.lowerCap)*10000/c.stepBps,initialized:false,
    cashLamports:c.budgetLamports,tokenRaw:'0',initialCashLamports:'0',initialTokenRaw:'0',feesLamports:'0',rawUnitLamports};
}
/** Target portfolio weights at fixed range levels; only managed assets enter valuation. */
export function allocationOrder(c:LadderConfig,s:AllocationState,side:'buy'|'sell',anchorUnitLamports=s.rawUnitLamports):LadderOrder|null{
  validateAllocation(c);
  const levels=10000/c.stepBps;
  const bin=s.initialized?(side==='sell'?Math.floor(s.bin+1e-9)+1:Math.ceil(s.bin-1e-9)-1):s.bin;
  if(bin<0||bin>levels||(!s.initialized&&side==='sell'&&BigInt(s.tokenRaw)===0n))return null;
  const cap=s.initialized?c.lowerCap+(c.upperCap-c.lowerCap)*bin/levels:Math.max(c.lowerCap,Math.min(c.upperCap,s.anchorCap));
  const cash=BigInt(s.cashLamports),tokens=BigInt(s.tokenRaw),unit=anchorUnitLamports*cap/s.anchorCap;
  if(!Number.isFinite(unit)||unit<=0||!Number.isFinite(s.bin)||!Number.isFinite(s.anchorCap)||s.anchorCap<=0||cash<0n||tokens<0n||tokens>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Invalid managed allocation');
  const cashWeight=(cap-c.lowerCap)/(c.upperCap-c.lowerCap);
  const equity=Number(cash)+Number(tokens)*unit;
  if(!Number.isFinite(equity)||equity>Number.MAX_SAFE_INTEGER)throw Error('Managed valuation exceeds precision bound');
  const delta=equity*cashWeight-Number(cash);
  let amount:bigint;
  if(side==='buy')amount=bin===0?cash:BigInt(Math.max(0,Math.floor(-delta)));
  else amount=bin===levels?tokens:BigInt(Math.max(0,Math.floor(delta/unit)));
  const available=side==='buy'?cash:tokens;if(amount>available)amount=available;
  if(amount<=0n)return null;
  return {side,kind:s.initialized?(bin===0||bin===levels?'boundary':'step'):'initial',cap,bin,amountRaw:amount.toString()};
}
