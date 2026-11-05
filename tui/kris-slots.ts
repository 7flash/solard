/** Kris's slots: which new pairs and fresh migrations to hold right now. Pure: the coins go in, at most one action comes
 * out. slrd-kris carries the action out through the terminal API.
 *   new pair: 4 to 10 minutes old, past the first dump (149 tracked coins: median -19% in the first 5 minutes, -3% from
 *   5 to 10). migrated: migrated in the last 10, and sized larger (median +4% from 1 to 10 minutes).
 * A full side swaps its weakest coin only for one clearly better, so fees are not paid for noise. */
export type SlotCoin = { mint: string; symbol?: string | null; capUsd?: number | null; trades?: number; traders?: number; smart?: number; volSol?: number; ageMs?: number | null; migrated?: boolean };
export type SlotKind = "new" | "migrated";
export type Slot = { mint: string; symbol: string | null; kind: SlotKind; openedAtMs: number; score: number; buy: number; sell: number };
export type SlotAction = { type: "open"; kind: SlotKind; coin: SlotCoin; score: number; buy: number; sell: number; swap: boolean } | { type: "close"; slot: Slot; reason: string; forSwap: boolean };

export const SLOT_CONFIG = { maxNew: 16, maxMigrated: 8, budgetSol: 0.02, migratedBudgetSol: 0.02, minSizeSol: 0.02, steps: 6, newBuyUsd: 5_000, newSellUsd: 60_000, gasSol: 0.02, newMinAgeMs: 240_000, newAgeMs: 600_000, migratedAgeMs: 600_000, actionGapMs: 15_000, swapGapMs: 30_000, minHoldMs: 300_000, swapRatio: 2, rotateNewMs: 900_000, rotateMigratedMs: 900_000, staleMs: 1_800_000, reopenAfterMs: 1_800_000, maxBundleShare: 0.3, smallBundleShare: 0.1, maxEarlyPct: 60, smallEarlyPct: 25 };
type Config = typeof SLOT_CONFIG;

/** Distinct wallets count most, smart wallets far more, volume a little. Few wallets across many trades is churn. */
export function slotScore(c: SlotCoin) {
  const traders = c.traders ?? 0, trades = c.trades ?? 0;
  const spread = trades ? Math.min(1, (traders / trades) / 0.4) : 0;
  return (traders + (c.volSol ?? 0) + (c.smart ?? 0) * 100) * spread;
}

/** Worth holding at all. Limits follow the daemon's automatic entries where it has them. */
export function slotQualifies(c: SlotCoin, kind: SlotKind) {
  const cap = c.capUsd ?? 0, traders = c.traders ?? 0, trades = c.trades ?? 0;
  if (trades === 0 || traders / trades < 0.2) return false;
  return kind === "new" ? cap >= 6_000 && cap <= 60_000 && traders >= 40 && trades >= 60 : cap >= 15_000 && cap <= 500_000 && traders >= 100;
}

const round = (v: number) => { const m = 10 ** (Math.floor(Math.log10(v)) - 1); return Math.round(v / m) * m; };
/** A slot ending never sells: a bot holding tokens stays on its range, only an empty one stops. */
export const slotKeepsRange = (holdingSteps?: number | null) => (holdingSteps ?? 0) > 0;
/** Only a coin watched on the curve and then seen migrated. An old pair that just got busy first appears already migrated. */
export const freshMigration = (wasMigrated: boolean | undefined, migrated: boolean) => wasMigrated === false && migrated;
export const slotRange = (cap: number, kind: SlotKind = "migrated") => kind === "new" ? { buy: SLOT_CONFIG.newBuyUsd, sell: SLOT_CONFIG.newSellUsd } : { buy: round(cap * 0.6), sell: round(cap * 1.9) };

export function planSlots(o: { coins: SlotCoin[]; slots: Slot[]; heldMints: Set<string>; closedAt: Map<string, number>; migratedAt: Map<string, number>; freeSol: number; nowMs: number; lastActionMs: number; lastSwapMs: number; pendingKind?: SlotKind | null; /** When each coin was last seen trading. Absent from a list is not quiet: lists empty out on a daemon restart. */ lastSeen?: Map<string, number>; /** Slots holding nothing: the range sold out at its top, so the slot is free to move on. */ emptyMints?: Set<string>; config?: Partial<Config> }): SlotAction | null {
  const c = { ...SLOT_CONFIG, ...o.config }, now = o.nowMs;
  if (now - o.lastActionMs < c.actionGapMs) return null;
  const live = new Map(o.coins.map(x => [x.mint, x]));
  // The range decides what a position does: a slot only ends when the coin goes quiet, or by a swap below.
  for (const s of o.slots) if (!live.has(s.mint) && now - (o.lastSeen?.get(s.mint) ?? now) > c.staleMs) return { type: "close", slot: s, reason: "went quiet", forSwap: false };
  for (const kind of ["new", "migrated"] as const) {
    const max = kind === "new" ? c.maxNew : c.maxMigrated, mine = o.slots.filter(s => s.kind === kind);
    const fresh = (x: SlotCoin) => kind === "new" ? !x.migrated && x.ageMs != null && x.ageMs >= c.newMinAgeMs && x.ageMs <= c.newAgeMs : !!x.migrated && now - (o.migratedAt.get(x.mint) ?? 0) <= c.migratedAgeMs;
    const best = o.coins.filter(x => !o.heldMints.has(x.mint) && now - (o.closedAt.get(x.mint) ?? 0) > c.reopenAfterMs && fresh(x) && slotQualifies(x, kind))
      .map(coin => ({ coin, score: slotScore(coin) })).sort((a, b) => b.score - a.score)[0];
    if (!best) continue;
    if (mine.length < max) {
      if (o.freeSol < c.budgetSol + c.gasSol) continue;
      return { type: "open", kind, coin: best.coin, score: best.score, ...slotRange(best.coin.capUsd!, kind), swap: o.pendingKind === kind };
    }
    if (now - o.lastSwapMs < c.swapGapMs) continue;
    // A slot is for fresh coins. An old one always has more wallets than a new one, so it gives way by age, not by score.
    const empty = (s: Slot) => !!o.emptyMints?.has(s.mint);
    // Only a sold-out slot gives way. A coin still held stays on its range and in its slot, so money in coins stays bounded by the slots.
    const now_ = mine.filter(empty).map(s => ({ s, score: -1 })).sort((a, b) => a.s.openedAtMs - b.s.openedAtMs)[0];
    if (!now_) continue;
    if (now - now_.s.openedAtMs >= c.minHoldMs && best.score > now_.score * c.swapRatio) return { type: "close", slot: now_.s, reason: `${best.coin.symbol ?? best.coin.mint.slice(0, 6)} looks stronger`, forSwap: true };
  }
  return null;
}
