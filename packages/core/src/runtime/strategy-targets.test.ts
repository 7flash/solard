import { expect, test } from "bun:test";
import { strategyTargetRow, targetsCsv } from "./strategy-targets.ts";
const now = 1_800_000_000_000;
function input() {
  return { mint: "mint", wallet: "ddm6", now, windowMs: 300_000, intervalMs: 5000, range: 0.02, profit: 0.01,
    state: { phase: "sell" as const, pending: null, position: { amountRaw: "100000000", costLamports: "100000000" },
      prices: Array.from({ length: 60 }, (_, i) => ({ time: now - (59 - i) * 5000, price: 0.0001 })) },
    metadata: { supplyRaw: 1_000_000_000_000_000n, decimals: 6, verifiedAtMs: now },
    solUsd: { price: 200, source: "verified-test", atMs: now } };
}
test("CSV targets use verified supply, decimals, USD and the stricter actual sell floor", () => {
  const row = strategyTargetRow(input());
  expect(row.status).toBe("READY");
  expect(row.buy_market_cap_usd).toBeCloseTo(19_600_000, 4);
  expect(row.sell_market_cap_usd).toBeCloseTo(20_400_000, 4);
  expect(row.profit_floor_sol).toBe(0.101);
  expect(row.effective_sell_price_sol).toBe(0.00101);
  expect(row.effective_sell_market_cap_usd).toBeCloseTo(202_000_000, 4);
  const csv = targetsCsv([row, { ...row, token_mint: "another", wallet: 'a,"b' }]);
  expect(csv.split("\r\n")).toHaveLength(4);
  expect(csv).toContain('"a,""b"');
});
test("stale/missing metadata never fabricates USD caps or actionable warmup targets", () => {
  const value = input();
  const usdStale = strategyTargetRow({ ...value, solUsd: { ...value.solUsd, atMs: now - 120_001 } });
  expect(usdStale.status).toBe("USD_UNAVAILABLE"); expect(usdStale.buy_market_cap_usd).toBeNull();
  const missing = strategyTargetRow({ ...value, metadata: undefined });
  expect(missing.market_cap_usd).toBeNull(); expect(missing.status).toBe("SUPPLY_UNAVAILABLE");
  const warm = strategyTargetRow({ ...value, state: { ...value.state, prices: value.state.prices.slice(-3) } });
  expect(warm.status).toBe("WARMING_UP"); expect(warm.buy_price_sol).toBeNull();
  const stale = strategyTargetRow({ ...value, now: now + 20_000 });
  expect(stale.status).toBe("STALE_PRICE"); expect(stale.effective_sell_market_cap_usd).toBeNull();
});

test("SMA-only exits do not apply an entry-cost profit floor", () => {
  const value = input();
  const row = strategyTargetRow({ ...value, state: { ...value.state, sellAtLoss: true } });
  expect(row.profit_floor_sol).toBeNull();
  expect(row.effective_sell_price_sol).toBeCloseTo(0.000102, 12);
});

test("leading CSV fields explain the next actionable market-cap target", () => {
 const value=input();
 const row=strategyTargetRow({...value,state:{...value.state,phase:"buy",position:null}});
 expect(row.next_action).toBe("WAIT TO BUY");
 expect(row.next_target_mcap_usd).toBe(19600000);
 expect(row.waiting_for).toBe("Buy at or below $19,600,000 market cap");
 const warm=strategyTargetRow({...value,state:{...value.state,prices:[]}});
 expect(warm.next_target_mcap_usd).toBeNull();
 expect(warm.next_action).not.toBe("WAIT TO SELL");
});

test("stopped workers show no next actionable target",()=>{
 const value=input();const row=strategyTargetRow({...value,state:{...value.state,running:false}});
 expect(row.status).toBe('STOPPED');expect(row.next_action).toBe('STOPPED');expect(row.next_target_mcap_usd).toBeNull();
});

test("fixed targets need only a fresh sample and ignore SMA/profit warmup",()=>{
 const value=input();
 const row=strategyTargetRow({...value,state:{...value.state,strategy:{kind:'fixed',buyPriceSol:'0.00009',sellPriceSol:'0.00011'},prices:[{time:now,price:0.0001}]}});
 expect(row.status).toBe('READY');expect(row.buy_price_sol).toBe(.00009);expect(row.effective_sell_price_sol).toBe(.00011);expect(row.profit_floor_sol).toBeNull();
 const stale=strategyTargetRow({...value,now:now+20000,state:{...value.state,strategy:{kind:'fixed',buyPriceSol:'0.00009',sellPriceSol:'0.00011'},prices:[{time:now,price:0.0001}]}});
 expect(stale.status).toBe('STALE_PRICE');expect(stale.next_target_mcap_usd).toBeNull();
});
