import { expect, test } from "bun:test";
import { followable, followStream, relayWallets } from "./smart-entry.ts";
import { scoreAll, scoreStream, type StatRow } from "./wallet-scores.ts";

// A deterministic spread of wallets and coins, including a relay-shaped wallet and coins under the 10 buyer limit.
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const now = Date.parse("2026-11-05T00:00:00Z"), rows: StatRow[] = [];
for (let c = 0; c < 30; c++) for (let w = 0; w < 40; w++) {
  if (rnd() < 0.45) continue;
  const solIn = 0.1 + rnd() * 3, first = now - 86_400_000 * rnd() * 5, sold = rnd() < 0.8;
  rows.push({ trader: `w${w}`, mint: `m${c}`, buys: 1 + Math.floor(rnd() * 5), sells: sold ? 1 + Math.floor(rnd() * 3) : 0, solIn, solOut: sold ? solIn * (0.4 + rnd() * 3) : 0,
    tokensBought: 1000, tokensSold: sold ? 1000 : 200, lastPriceSol: 0.001 + rnd() / 100, entryCapUsd: 10_000 + rnd() * 50_000, exitCapUsd: sold ? 20_000 + rnd() * 90_000 : null, firstAtMs: first, lastAtMs: first + 3_600_000 * (1 + rnd() * 20) });
}
for (let c = 0; c < 60; c++) rows.push({ trader: "relay", mint: `r${c}`, buys: 20, sells: 0, solIn: 5, solOut: 0, tokensBought: 1, tokensSold: 0, lastPriceSol: 0.01, firstAtMs: now - 1000, lastAtMs: now });
const order = (k: "mint" | "trader") => [...rows].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0));
const byTrader = (x: { trader: string }, y: { trader: string }) => (x.trader < y.trader ? -1 : 1);

test("streamed scores equal the scores from the whole table", () => {
  const a = scoreAll(rows).sort(byTrader), b = scoreStream(order("mint"), order("trader")).sort(byTrader);
  expect(b.length).toBe(a.length);
  a.forEach((s, i) => { const t = b[i]!; expect(t.trader).toBe(s.trader); expect(t.pnlSol).toBeCloseTo(s.pnlSol, 9); expect(t.coins).toBe(s.coins); expect(t.earlyCoins).toBe(s.earlyCoins); expect(t.avgRankPct).toBeCloseTo(s.avgRankPct, 3); expect(t.medHoldMin).toBe(s.medHoldMin); expect(t.openSol).toBeCloseTo(s.openSol, 9); });
});
test("the filter drops wallets while streaming", () => {
  expect(scoreStream(order("mint"), order("trader"), s => s.coins >= 1000)).toEqual([]);
});
test("streamed follow list equals the list from the whole table", () => {
  const prices = new Map<string, number>(), at = new Map<string, number>();
  for (const r of rows) if (r.lastPriceSol != null && (at.get(r.mint) ?? 0) < r.lastAtMs) { at.set(r.mint, r.lastAtMs); prices.set(r.mint, r.lastPriceSol); }
  const earliest = Math.min(...rows.map(r => r.firstAtMs)), s = followStream({ prices, earliest }, order("trader") as never, now), relays = relayWallets(rows as never);
  expect([...s.relays].sort()).toEqual([...relays].sort()); expect(relays.has("relay")).toBe(true);
  const whole = [...followable(rows as never, now).keys()].filter(t => !relays.has(t)).sort();
  expect([...s.list.keys()].sort()).toEqual(whole);
});
