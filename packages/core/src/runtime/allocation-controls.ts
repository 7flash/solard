import {PublicKey} from '@solana/web3.js';
import {allocationBudget,type SelectedAllocation} from './selected-allocations.ts';
import {validateAllocation} from './range-allocation.ts';
import type {LadderConfig} from './bid-ask-ladder.ts';
export type AllocationControl=Omit<SelectedAllocation,'pool'> & {pool?:string;enabled?:boolean};
export function controlLadder(row:AllocationControl):LadderConfig{
 return {lowerCap:row.lower,upperCap:row.upper,stepBps:row.stepPercent*100,portionBps:500,budgetLamports:String(allocationBudget(row.budget)),sizing:'fixed',bounds:'allocate'};
}
export function parseAllocationControls(input:unknown,wallet:string):AllocationControl[]{
 const rows=(Array.isArray(input)?input:[input]) as AllocationControl[];
 if(!rows.length||rows.length>8)throw Error('One to eight positions required');
 const mints=new Set<string>();
 for(const row of rows){
  if(!row||typeof row!=='object'||row.wallet!==wallet||mints.has(row.mint))throw Error('Positions need the shared wallet and distinct mints');
  new PublicKey(row.mint);if(row.pool)new PublicKey(row.pool);mints.add(row.mint);validateAllocation(controlLadder(row));
  if(row.enabled!==undefined&&typeof row.enabled!=='boolean')throw Error('Invalid enabled value');
 }
 return rows;
}
