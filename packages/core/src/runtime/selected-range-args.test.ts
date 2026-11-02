import {expect,test} from "bun:test";
import {selectedRangeRuns,selectedRangeRpc,selectedPublicRpcPool} from "./selected-range-args.ts";
const first="CW8ZQeKbGTk1TYY79QMjhp81R48AKVv1imNimgmrpump",second="DqGGPdUfL9BuCWyLybF82tkqKKXX9VbsVwwcEUQmpump";
test("selected runner starts exactly the named mints while preserving shared wallet settings",()=>{
 const args=["--live","--mint",first,"--wallet","mements-server-bullish-bandit-a-1c4f","--amount","0.1","--ranges-csv","ranges.csv","--also-mint",second];
 const runs=selectedRangeRuns(args);expect(runs).toHaveLength(2);
 expect(runs.map(r=>r[r.indexOf("--mint")+1])).toEqual([first,second]);
 for(const run of runs){expect(run.includes("--also-mint")).toBe(false);expect(run.includes("--live")).toBe(false);expect(run[run.indexOf("--wallet")+1]).toBe("mements-server-bullish-bandit-a-1c4f");}
 expect(args).toContain("--also-mint");
});
test("public RPC fallback preserves provider quotas and never silently adds private endpoints",()=>{
 expect(selectedPublicRpcPool("https://api.mainnet-beta.solana.com")).toEqual(["https://api.mainnet-beta.solana.com","https://solana-rpc.publicnode.com/"]);
 expect(selectedPublicRpcPool("https://private.example/key")).toEqual(["https://private.example/key"]);
 expect(selectedPublicRpcPool("https://api.mainnet-beta.solana.com/?custom=1")).toEqual(["https://api.mainnet-beta.solana.com/?custom=1"]);
});
test("readiness-selected RPC replaces an explicit failed endpoint and is shared by worker reads",()=>{
 const args=["--mint",first,"--rpc-url","https://failed.example"];
 expect(selectedRangeRpc(args,"https://working.example")).toEqual(["--mint",first,"--rpc-url","https://working.example"]);
 expect(args[3]).toBe("https://failed.example");
 expect(selectedRangeRpc(["--mint",first],"https://working.example")).toEqual(["--mint",first,"--rpc-url","https://working.example"]);
});
test("a single selection remains single and invalid or duplicate identities fail before startup",()=>{
 expect(selectedRangeRuns(["--probe-only","--mint",first])).toEqual([["--mint",first]]);
 expect(()=>selectedRangeRuns(["--mint",first,"--also-mint",first])).toThrow("distinct");
 expect(()=>selectedRangeRuns(["--mint",first,"--also-mint","invalid"])).toThrow();
 expect(()=>selectedRangeRuns(["--mint",first,"--also-mint",second,"--also-mint",second])).toThrow();
});
test("three explicit selections share options without reviving unnamed CSV rows",()=>{
 const third="GhykjRdHNYa6i5umNVWEUubZ9A36jaKJWQaKTwAJpump";
 const runs=selectedRangeRuns(["--live","--mint",first,"--also-mint",second,"--also-mint",third,"--wallet","bullish"]);
 expect(runs.map(r=>r[r.indexOf("--mint")+1])).toEqual([first,second,third]);
 expect(runs.every(r=>!r.includes("--also-mint")&&r[r.indexOf("--wallet")+1]==="bullish")).toBe(true);
});
