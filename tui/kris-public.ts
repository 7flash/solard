/** What Kris shows in public on purpose. The publisher refuses every other wallet. */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tradedFromLog } from "./fill-log.ts";

export const KRIS_WALLET = "FaezkixuFKvFQS2NPPopZ7PzTd1a41MsMncunRkTLbgr";
export type KrisTotals = { volumeSol: number; trades: number; coins: number };
let cached: KrisTotals = { volumeSol: 0, trades: 0, coins: 0 }, cachedAt = 0;

/** All SOL Kris has traded, from the bot logs. Read at most every 5 minutes. */
export function krisTotals(root: string): KrisTotals {
  if (Date.now() - cachedAt < 300_000) return cached;
  cachedAt = Date.now();
  const dir = resolve(root, ".range-bots"), sum = { volumeSol: 0, trades: 0, coins: 0 };
  for (const f of readdirSync(dir)) {
    if (!/^term-bgr-.*\.log$/.test(f)) continue;
    const t = tradedFromLog(readFileSync(resolve(dir, f), "utf8"));
    if (t.trades) { sum.volumeSol += t.sol; sum.trades += t.trades; sum.coins++; }
  }
  return cached = { ...sum, volumeSol: Math.round(sum.volumeSol * 100) / 100 };
}
