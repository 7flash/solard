import {test,expect} from "bun:test";
import {ThresholdHold} from "./threshold-hold.ts";

test("two-second hold needs multiple fresh observations; waking on one cached tick cannot trigger",()=>{
  const hold=new ThresholdHold(2000,1500);
  hold.observe("buy:max20",0,0);
  expect(hold.ready("buy:max20",1000)).toBe(false);
  hold.observe("buy:max20",0,1000);
  expect(hold.ready("buy:max20",2000)).toBe(false);
  hold.observe("buy:max20",1000,1000);hold.observe("buy:max20",2000,2000);
  expect(hold.ready("buy:max20",2000)).toBe(true);
  expect(hold.ready("buy:max20",3501)).toBe(false);
});
test("threshold recross, range/size edit, stale gap and future observation reset the hold",()=>{
  const hold=new ThresholdHold(2000,1500);
  hold.observe("sell:100:min30",0,0);hold.observe("sell:100:min30",1000,1000);
  hold.observe(undefined,1500,1500);hold.observe("sell:100:min30",2000,2000);
  expect(hold.ready("sell:100:min30",2000)).toBe(false);
  hold.observe("sell:100:min31",3000,3000);expect(hold.ready("sell:100:min31",3000)).toBe(false);
  hold.observe("sell:100:min31",5000,5000);expect(hold.ready("sell:100:min31",5000)).toBe(false);
  hold.observe("sell:100:min31",7000,6000);expect(hold.ready("sell:100:min31",6000)).toBe(false);
  hold.reset();expect(hold.ready("sell:100:min31",6000)).toBe(false);
  expect(new ThresholdHold(0,1500).ready("buy",0)).toBe(true);
  expect(()=>new ThresholdHold(-1,1500)).toThrow();
});
