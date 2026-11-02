import {PublicKey} from '@solana/web3.js';
import {validateAllocation} from './range-allocation.ts';
export type SelectedAllocation={mint:string;wallet:string;pool:string;lower:number;upper:number;budget:string;stepPercent:number;venue?:'pump-curve';adoptSignature?:string;adoptCurrentHoldings?:boolean};
export function allocationBudget(value:string):bigint{
 if(typeof value!=='string'||!/^\d+(?:\.\d{1,9})?$/.test(value))throw Error('Allocation budget must be a positive SOL decimal');
 const [whole,fraction='']=value.split('.');return BigInt(whole!)*1000000000n+BigInt(fraction.padEnd(9,'0'));
}
export function selectedAllocations(input:unknown,wallet:string,rangeMints:string[]):SelectedAllocation[]{
 if(input===undefined)return [];
 const rows=(Array.isArray(input)?input:[input]) as SelectedAllocation[];
 if(!rows.length||rows.length+rangeMints.length>8)throw Error('At most eight total selected strategies');
 const seen=new Set(rangeMints);
 for(const row of rows){
  if(!row||typeof row!=='object'||row.wallet!==wallet||seen.has(row.mint))throw Error('Each allocation requires the shared wallet and a distinct mint');
  new PublicKey(row.mint);new PublicKey(row.pool);seen.add(row.mint);
  validateAllocation({lowerCap:row.lower,upperCap:row.upper,stepBps:row.stepPercent*100,portionBps:500,
   budgetLamports:String(allocationBudget(row.budget)),sizing:'fixed',bounds:'allocate'});
 }
 return rows;
}
export function reserveManagedCash(allocations:Array<{budget:string;cashLamports?:string}>,unspentRangeBudgets:bigint[]):bigint{
 return allocations.reduce((sum,a)=>sum+BigInt(a.cashLamports??allocationBudget(a.budget)),0n)+unspentRangeBudgets.reduce((sum,n)=>sum+n,0n);
}
