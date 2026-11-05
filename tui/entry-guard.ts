/** Checks every automatic entry (migration watcher, smart wallets) must pass before a bot is opened.
 *
 * 1. Concentration: buyers of the first 3s after launch (dev + bundle + snipers) holding more than 25% of supply,
 *    or the top 10 holding more than 70%, own the coin and can dump it on us.
 * 2. Honeypot: quote a sell of one step's worth of tokens right now. If it returns more than 15% less than the
 *    market price says (fees and impact on a 0.02 SOL step are ~1-2%), the price shown is not one we can exit at.
 * Env: SLRD_GUARD_EARLY_PCT (25), SLRD_GUARD_TOP10_PCT (70), SLRD_GUARD_SELL_LOSS_PCT (15). */
import type { Solard } from "../packages/sdk/src/client.ts";

const env = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };

export type GuardDeps = {
  client: Solard;
  concentration: (mint: string) => { wallets: number; top10Pct: number; earlyPct: number } | null;
  priceSol: (mint: string) => number | null;
};

/** null = ok to enter; otherwise the reason not to. */
export async function entryGuard(d: GuardDeps, mint: string, stepSol: number): Promise<string | null> {
  const c = d.concentration(mint);
  if (c && c.wallets >= 20) {
    if (c.earlyPct > env("SLRD_GUARD_EARLY_PCT", 25)) return `first-3s buyers hold ${c.earlyPct.toFixed(0)}% of supply (dev/bundle)`;
    if (c.top10Pct > env("SLRD_GUARD_TOP10_PCT", 70)) return `top 10 wallets hold ${c.top10Pct.toFixed(0)}% of supply`;
  }
  const price = d.priceSol(mint);
  if (!price || !(price > 0)) return null; // no price to compare: the bot's own price guard still applies per trade
  const decimals = mint.endsWith("pump") ? 6 : null;
  if (decimals == null) return null;
  const tokens = stepSol / price, amountRaw = BigInt(Math.max(1, Math.floor(tokens * 10 ** decimals)));
  for (let attempt = 1; ; attempt++) try {
    const q = await d.client.quoteSell(mint, amountRaw, 1500);
    const gotSol = Number(q.quote.expectedOutputRaw) / 1e9, fair = tokens * price;
    const loss = (1 - gotSol / fair) * 100;
    if (loss > env("SLRD_GUARD_SELL_LOSS_PCT", 15)) return `honeypot: selling ${stepSol} SOL worth returns ${gotSol.toFixed(4)} SOL (${loss.toFixed(0)}% below the market price)`;
    break;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    // Our RPC failing is not the coin failing: retry twice, then let the entry through (the concentration check
    // passed and every trade keeps its own on-chain price guard). Any other quote failure blocks the entry.
    if (/RPC_|timed? ?out|fetch failed|ECONN|429/i.test(text)) { if (attempt < 3) { await Bun.sleep(1_000); continue; } return null; }
    return `honeypot check failed: no sell quote (${text.slice(0, 80)})`;
  }
  return null;
}
