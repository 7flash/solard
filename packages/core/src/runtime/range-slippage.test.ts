import {test,expect} from "bun:test";
import {rangeSlippageBps} from "./range-slippage.ts";
import {fixedPriceBand} from "./fixed-price-band.ts";

test("range allowance scales with spread, floors to bps and never exceeds 2%",()=>{
  expect(rangeSlippageBps(fixedPriceBand("100","105"))).toBe(50);
  expect(rangeSlippageBps(fixedPriceBand("100","120"))).toBe(200);
  expect(rangeSlippageBps(fixedPriceBand("100","200"))).toBe(200);
  expect(rangeSlippageBps(fixedPriceBand("540","580"))).toBe(74);
  expect(rangeSlippageBps(fixedPriceBand("1e-9","1.00001e-9"))).toBe(0);
  expect(rangeSlippageBps(fixedPriceBand("100","105"),500)).toBe(25);
  expect(rangeSlippageBps(fixedPriceBand("100","105"),10000)).toBe(200);
  expect(rangeSlippageBps({kind:"fixed",buyPriceSol:"100",sellPriceSol:"90",entryPaused:true})).toBe(0);
  for(const share of [-1,0.5,10001,NaN])expect(()=>rangeSlippageBps(fixedPriceBand("100","105"),share)).toThrow();
});
