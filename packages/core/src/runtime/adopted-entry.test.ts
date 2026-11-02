import {expect,test} from "bun:test";
import {adoptedEntry} from "./adopted-entry.ts";
import {tradeRows} from "./trade-history-csv.ts";
const signature="4iEst2KdXskr73b4gYwEhoRMmj6GxNvBwZBc7V7tzWGbMBen3vqmrcxNRhiMQ5g6kNj6vaVkK4UZkVG6MGvLUQef";
const proof={source:"confirmed-chain-acquisition",wallet:"bullish",mint:"mint",signature,atMs:1792875909000,
  amountRaw:"1183754608891",costLamports:"100006000",networkFeeLamports:"5004"};
test("adoption retains exact fee-inclusive acquisition cost without fabricating a bot execution",()=>{
 const buy=adoptedEntry(proof,"bullish","mint");expect(buy.tokens).toBe("1183754608891");expect(buy.principal).toBe("-100000996");
 const rows=tradeRows([buy],6);expect(rows[0].status).toBe("OPEN");expect(rows[0].buy_cost_sol).toBe(.100006);expect(rows[0].buy_signature).toBe(signature);
});
test("a later actual sell pairs once with adoption and deducts both sides' costs",()=>{
 const buy=adoptedEntry(proof,"bullish","mint");const sell={side:"sell",signature:"actual-sell",time:proof.atMs+10000,tokens:"-1183754608891",principal:"130000000",fee:"17000"};
 const rows=tradeRows([buy,buy,sell],6);expect(rows).toHaveLength(1);expect(rows[0].status).toBe("SOLD");expect(rows[0].profit_sol).toBeCloseTo(.029977,9);
});
test("another wallet/mint, invalid cost, or mismatched later inventory cannot be silently attributed",()=>{
 expect(()=>adoptedEntry(proof,"other","mint")).toThrow();expect(()=>adoptedEntry(proof,"bullish","other")).toThrow();
 expect(()=>adoptedEntry({...proof,costLamports:"1"},"bullish","mint")).toThrow();
 const buy=adoptedEntry(proof,"bullish","mint");expect(()=>tradeRows([buy,{side:"sell",time:proof.atMs+1,signature:"bad-sell",tokens:"-1",principal:"1",fee:"0"}],6)).toThrow("review");
});
