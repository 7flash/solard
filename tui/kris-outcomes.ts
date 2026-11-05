/** What happened to each coin after Kris judged it: the cap at set times after the call, written once it is complete. This
 * is the record Kris needs to learn from: the trade stream forgets a coin within minutes. Pure apart from the caller's write. */
export type Outcome = { mint: string; symbol: string | null; kind: string; verdict: string; atMs: number; cap: number; wallets: number; trades: number; smart: number; volSol: number; at: Record<string, number | null>; high: number; low: number };

export const OUTCOME_MINUTES = [1, 3, 5, 10, 30];

export function startOutcome(c: { mint: string; symbol?: string | null; capUsd?: number | null; traders?: number; trades?: number; smart?: number; volSol?: number }, kind: string, verdict: string, nowMs: number): Outcome | null {
  if (!c.capUsd) return null;
  return { mint: c.mint, symbol: c.symbol ?? null, kind, verdict, atMs: nowMs, cap: c.capUsd, wallets: c.traders ?? 0, trades: c.trades ?? 0, smart: c.smart ?? 0, volSol: c.volSol ?? 0, at: {}, high: c.capUsd, low: c.capUsd };
}

/** Takes the latest cap (null if the coin left the live list). True once every time has passed. */
export function stepOutcome(o: Outcome, cap: number | null, nowMs: number) {
  if (cap != null) { o.high = Math.max(o.high, cap); o.low = Math.min(o.low, cap); }
  for (const m of OUTCOME_MINUTES) if (!(m in o.at) && nowMs - o.atMs >= m * 60_000) o.at[m] = cap;
  return OUTCOME_MINUTES.every(m => m in o.at);
}
