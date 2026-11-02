import {expect,test} from "bun:test";
import {freshPreparation} from "./fresh-preparation.ts";
test("expired unsent preparation retries with a new lease, never loosening the expiry guard",async()=>{
 let calls=0;const retries:number[]=[];
 expect(await freshPreparation(async()=>{calls++;if(calls<3)throw Error("Background preparation exceeded freshness lease");return "fresh";},n=>retries.push(n))).toBe("fresh");
 expect(calls).toBe(3);expect(retries).toEqual([2,3]);
});
test("preparation retries are bounded and unrelated failures never retry",async()=>{
 let calls=0;await expect(freshPreparation(async()=>{calls++;throw Error("Background preparation exceeded freshness lease");})).rejects.toThrow("freshness");expect(calls).toBe(3);
 calls=0;await expect(freshPreparation(async()=>{calls++;throw Error("Unallocated holding");})).rejects.toThrow("Unallocated");expect(calls).toBe(1);
});
