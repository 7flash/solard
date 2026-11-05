/** Entry before migration. In two days of curve data, coins reaching $20-35k within 15 min of launch with 30+ wallets
 * migrated 82% of the time, 66% reached +50% and 48% doubled, while most ended under half: climb fast, sell into the move.
 * Coins that low on the curve barely migrate ($5-10k: 6%), so the trigger is the climb, not being early.
 * Env: SLRD_CURVE=0 disables; SLRD_CURVE_MIN_CAP (20000), SLRD_CURVE_MAX_CAP (35000), SLRD_CURVE_MIN_WALLETS (30),
 * SLRD_CURVE_MAX_AGE_MIN (15), SLRD_CURVE_BUDGET (default entry size). */
export type CurveCoin = { mint: string; migrated: boolean; capUsd: number | null; launchedAtMs: number | null; traders?: { size: number } };
const env = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };

export function curveSignal(c: CurveCoin, now = Date.now()) {
  if (c.migrated || !c.capUsd || !c.launchedAtMs) return false;
  return c.capUsd >= env("SLRD_CURVE_MIN_CAP", 20_000) && c.capUsd <= env("SLRD_CURVE_MAX_CAP", 35_000)
    && (c.traders?.size ?? 0) >= env("SLRD_CURVE_MIN_WALLETS", 30) && now - c.launchedAtMs <= env("SLRD_CURVE_MAX_AGE_MIN", 15) * 60_000;
}
/** Sells between 0.7x and 2x of the entry cap, in 3 steps: the first sale sits about +50% up, where most of the edge is. */
export function curveRange(capUsd: number) {
  const round = (v: number) => Math.round(v / 100) * 100;
  return { buy: round(capUsd * 0.7), sell: round(capUsd * 2), steps: 3 };
}
