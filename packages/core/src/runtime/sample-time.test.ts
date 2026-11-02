import { test, expect } from "bun:test";
import { sampleObservationTime } from "./sample-time.ts";
test("fourteen-second RPC cannot masquerade as a newly captured trading price",()=>{
  const time=sampleObservationTime(1000,15000,15000);
  expect(time).toBe(1000);expect(15095-time).toBe(14095);
  expect(sampleObservationTime(10000,1000,15000)).toBe(1000);
  expect(()=>sampleObservationTime(20000,1000,15000)).toThrow();
  expect(()=>sampleObservationTime(1000,20000,15000)).toThrow();
  expect(()=>sampleObservationTime(1000,NaN,15000)).toThrow();
});
