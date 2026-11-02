import{test,expect}from'bun:test';import{marketCapPrices}from'./market-cap-band.ts';import{parseRangeFile}from'./range-file.ts';
import { fixedPriceSignal } from './fixed-price-band.ts';

test('lowered exit target permits an open position to sell and prevents new overlapping buys',()=>{
 const spec=parseRangeFile('{"buyMarketCapUsd":"63000","sellMarketCapUsd":"37000"}');
 if(spec.kind!=='market-cap')throw Error('Expected cap band');
 const band=marketCapPrices(spec,{supply:1000000000000000n,decimals:6,atMs:1000},{price:100,atMs:1000},1000);
 expect(spec.entryPaused).toBe(true);
 expect(fixedPriceSignal('sell',0.00000038,band)).toBe('sell');
 expect(fixedPriceSignal('sell',0.00000036,band)).toBeNull();
 expect(fixedPriceSignal('buy',0.00000038,band)).toBeNull();
 expect(fixedPriceSignal('buy',0.00000020,band)).toBeNull();
 const restored=parseRangeFile('{"buyMarketCapUsd":"30000","sellMarketCapUsd":"37000"}');
 if(restored.kind!=='market-cap')throw Error('Expected cap band');
 const next=marketCapPrices(restored,{supply:1000000000000000n,decimals:6,atMs:1000},{price:100,atMs:1000},1000);
 expect(fixedPriceSignal('buy',0.00000029,next)).toBe('buy');
});
test('USD cap range scales with verified supply and fresh SOL/USD',()=>{
 const spec={kind:'market-cap' as const,buyMarketCapUsd:'20000',sellMarketCapUsd:'30000'};const mint={supply:1000000000000000n,decimals:6,atMs:1000};
 const a=marketCapPrices(spec,mint,{price:100,atMs:1000},1000);expect(Number(a.buyPriceSol)).toBeCloseTo(.0000002,14);expect(Number(a.sellPriceSol)).toBeCloseTo(.0000003,14);
 const b=marketCapPrices(spec,mint,{price:200,atMs:1000},1000);expect(Number(b.buyPriceSol)).toBe(Number(a.buyPriceSol)/2);
 expect(()=>marketCapPrices(spec,mint,{price:100,atMs:1000},122000)).toThrow('Fresh');
 expect(parseRangeFile('{"buyMarketCapUsd":"20000","sellMarketCapUsd":"30000"}').kind).toBe('market-cap');
});
