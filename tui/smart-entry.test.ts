import { expect, test } from "bun:test";
import { followable } from "./smart-entry.ts";

const now = Date.UTC(2026, 10, 3);
const row = (trader: string, i: number, o: Partial<{ buys: number; sells: number; solIn: number; solOut: number; holdMin: number }>) => ({
  trader, mint: `m${i}`, buys: o.buys ?? 1, sells: o.sells ?? 1, solIn: o.solIn ?? 1, solOut: o.solOut ?? 2,
  firstAtMs: now - 3_600_000, lastAtMs: now - 3_600_000 + (o.holdMin ?? 20) * 60_000,
});
const many = (trader: string, n: number, o: Parameters<typeof row>[2]) => Array.from({ length: n }, (_, i) => row(trader, i, o));

test("follows profitable discretionary traders only", () => {
  const rows = [
    ...many("trader", 8, { solIn: 1, solOut: 2, holdMin: 40 }),         // +100% per coin, 40 min holds
    ...many("oneluckycoin", 7, { solIn: 1, solOut: 0.4, holdMin: 40 }), ...many("oneluckycoin", 1, { solIn: 1, solOut: 90, holdMin: 40 }), // +85 SOL lifetime, loses on most coins
    ...many("bigloser", 7, { solIn: 1, solOut: 2, holdMin: 40 }), ...many("bigloser", 2, { solIn: 40, solOut: 5, holdMin: 40 }), // median +100%, lifetime -63 SOL
    ...many("sellonly", 8, { buys: 0, solIn: 0, solOut: 5 }),           // dev / bundle tokens: never bought
    ...many("arbbot", 50, { solIn: 1, solOut: 1.2, holdMin: 0.1 }),     // seconds-long holds
    ...many("loser", 8, { solIn: 1, solOut: 0.5 }),                     // loses money
    ...many("dust", 40, { solIn: 0.01, solOut: 0.2 }),                  // tiny size
    ...many("fewcoins", 3, { solIn: 1, solOut: 5 }),                    // not enough history
  ];
  expect([...followable(rows, now).keys()]).toEqual(["trader"]);
});
