import {test,expect} from 'bun:test';
import {parseAllocationControls,controlLadder} from './allocation-controls.ts';
const row={wallet:'shared',mint:'5Dw9h4ySRjRPcED7g23kabJ5KSpReKLitktM9TREpump',lower:62000,upper:170000,budget:'0.1',stepPercent:50};
test('UI controls can request discovery but retain all wallet/range/budget checks',()=>{
 expect(parseAllocationControls([row],'shared')).toEqual([row]);expect(controlLadder(row).stepBps).toBe(5000);
 expect(()=>parseAllocationControls([row,row],'shared')).toThrow();expect(()=>parseAllocationControls([row],'other')).toThrow();
 expect(()=>parseAllocationControls([{...row,lower:180000}],'shared')).toThrow();expect(()=>parseAllocationControls([{...row,budget:'-1'}],'shared')).toThrow();
});
