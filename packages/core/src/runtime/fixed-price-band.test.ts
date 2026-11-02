import{test,expect}from'bun:test';import{fixedPriceBand,fixedPriceSignal}from'./fixed-price-band.ts';
test('fixed band validates bounds and trades only the current position side at inclusive prices',()=>{
 const b=fixedPriceBand('0.000001','0.0000012');
 expect(fixedPriceSignal('buy',.000001,b)).toBe('buy');expect(fixedPriceSignal('buy',.0000011,b)).toBeNull();
 expect(fixedPriceSignal('sell',.0000011,b)).toBeNull();expect(fixedPriceSignal('sell',.0000012,b)).toBe('sell');
 for(const p of [['0','1'],['2','1'],['1','1'],['NaN','2'],['-1','2'],['1','Infinity']])expect(()=>fixedPriceBand(...p as [string,string])).toThrow();
 expect(fixedPriceBand('1e-7','2e-7').buyPriceSol).toBe('1e-7');
});

test('persisted manual entry pause survives reload and does not disable exits',()=>{
 const state=JSON.parse(JSON.stringify({entryPause:{reason:'MANUAL_EXIT',at:'2026-10-24T02:21:35+08:00'}}));
 const band=fixedPriceBand('14000','17000');
 expect(fixedPriceSignal('buy',10000,band,!!state.entryPause)).toBeNull();
 expect(fixedPriceSignal('sell',18000,band,!!state.entryPause)).toBe('sell');
 expect(fixedPriceSignal('buy',10000,band,false)).toBe('buy');
});
