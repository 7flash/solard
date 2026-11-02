import {test,expect} from 'bun:test';
import {selectedAllocations,reserveManagedCash,allocationBudget} from './selected-allocations.ts';
const row={mint:'EfgEGG9PxLhyk1wqtqgGnwgfVC7JYic3vC9BCWLvpump',pool:'DgqD4rmBKf3Upcy7GUkLMyosaP4HpzmUWSVsUZatJLkY',wallet:'shared',lower:364000,upper:611000,budget:'0.1',stepPercent:10};
test('explicit allocations share a wallet and cannot duplicate a range or another allocation',()=>{
 expect(selectedAllocations(row,'shared',[])).toEqual([row]);expect(selectedAllocations(undefined,'shared',[])).toEqual([]);
 expect(()=>selectedAllocations(row,'other',[])).toThrow();
 expect(()=>selectedAllocations(row,'shared',[row.mint])).toThrow();expect(()=>selectedAllocations([row,row],'shared',[])).toThrow();
 expect(()=>selectedAllocations({...row,pool:'invalid'},'shared',[])).toThrow();
 expect(()=>selectedAllocations({...row,stepPercent:30},'shared',[])).toThrow();
});
test('all allocation cash and waiting range budgets are reserved together',()=>{
 expect(reserveManagedCash([{budget:'0.1'},{budget:'0.025'}],[100000000n])).toBe(225000000n);
 expect(reserveManagedCash([{budget:'0.1',cashLamports:'40000000'},{budget:'0.025'}],[100000000n])).toBe(165000000n);
 expect(allocationBudget('0.000000001')).toBe(1n);expect(()=>allocationBudget('0.1234567891')).toThrow();
});
