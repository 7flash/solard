/** Kris's slots: which new pairs and fresh migrations to hold right now. Pure: the coins go in, at most one action comes
 * out. slrd-kris carries the action out through the terminal API.
 *   new pair: launched in the last 3 minutes. migrated: migrated in the last 10.
 * A full side swaps its weakest coin only for one clearly better, so fees are not paid for noise. */
export type SlotCoin = { mint: string; symbol?: string | null; capUsd?: number | null; trades?: number; traders?: number; smart?: number; volSol?: number; ageMs?: number | null; migrated?: boolean };
export type SlotKind = "new" | "migrated";
export type Slot = { mint: string; symbol: string | null; kind: SlotKind; openedAtMs: number; score: number; buy: number; sell: number };
export type SlotAction = { type: "open"; kind: SlotKind; coin: SlotCoin; score: number; buy: number; sell: number; swap: boolean } | { type: "close"; slot: Slot; reason: string; forSwap: boolean };

export const SLOT_CONFIG = { maxNew: 4, maxMigrated: 3, budgetSol: 0.05, minSizeSol: 0.03, maxSizeSol: 0.08, steps: 3, gasSol: 0.02, newAgeMs: 180_000, migratedAgeMs: 600_000, actionGapMs: 30_000, swapGapMs: 30_000, minHoldMs: 60_000, swapRatio: 1.2, rotateNewMs: 900_000, rotateMigratedMs: 900_000, staleMs: 1_800_000, reopenAfterMs: 1_800_000, maxBundleShare: 0.1 };
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
export const slotRange = (cap: number) => ({ buy: round(cap * 0.9), sell: round(cap * 1.2) });

export function planSlots(o: { coins: SlotCoin[]; slots: Slot[]; heldMints: Set<string>; closedAt: Map<string, number>; migratedAt: Map<string, number>; freeSol: number; nowMs: number; lastActionMs: number; lastSwapMs: number; pendingKind?: SlotKind | null; /** New pairs Kris chose by comparing them; when set, no other new pair opens. */ allowNew?: Set<string>; /** When each coin was last seen trading. Absent from a list is not quiet: lists empty out on a daemon restart. */ lastSeen?: Map<string, number>; /** Slots holding nothing: the range sold out at its top, so the slot is free to move on. */ emptyMints?: Set<string>; config?: Partial<Config> }): SlotAction | null {
  const c = { ...SLOT_CONFIG, ...o.config }, now = o.nowMs;
  if (now - o.lastActionMs < c.actionGapMs) return null;
  const live = new Map(o.coins.map(x => [x.mint, x]));
  // The range decides what a position does: a slot only ends when the coin goes quiet, or by a swap below.
  for (const s of o.slots) if (!live.has(s.mint) && now - (o.lastSeen?.get(s.mint) ?? now) > c.staleMs) return { type: "close", slot: s, reason: "went quiet", forSwap: false };
  for (const kind of ["new", "migrated"] as const) {
    const max = kind === "new" ? c.maxNew : c.maxMigrated, mine = o.slots.filter(s => s.kind === kind);
    const fresh = (x: SlotCoin) => kind === "new" ? !x.migrated && ((x.ageMs != null && x.ageMs <= c.newAgeMs) || !!o.allowNew?.has(x.mint)) : !!x.migrated && now - (o.migratedAt.get(x.mint) ?? 0) <= c.migratedAgeMs;
    const best = o.coins.filter(x => !o.heldMints.has(x.mint) && now - (o.closedAt.get(x.mint) ?? 0) > c.reopenAfterMs && fresh(x) && slotQualifies(x, kind) && (kind !== "new" || !o.allowNew || o.allowNew.has(x.mint)))
      .map(coin => ({ coin, score: slotScore(coin) })).sort((a, b) => b.score - a.score)[0];
    if (!best) continue;
    if (mine.length < max) {
      if (o.freeSol < c.budgetSol + c.gasSol) continue;
      return { type: "open", kind, coin: best.coin, score: best.score, ...slotRange(best.coin.capUsd!), swap: o.pendingKind === kind };
    }
    if (now - o.lastSwapMs < c.swapGapMs) continue;
    // A slot is for fresh coins. An old one always has more wallets than a new one, so it gives way by age, not by score.
    const rotateAfter = kind === "new" ? c.rotateNewMs : c.rotateMigratedMs, empty = (s: Slot) => !!o.emptyMints?.has(s.mint);
    const now_ = mine.map(s => ({ s, score: empty(s) ? -1 : now - s.openedAtMs >= rotateAfter ? 0 : live.has(s.mint) ? slotScore(live.get(s.mint)!) : s.score / 2 })).sort((a, b) => a.score - b.score)[0]!;
    // A new pair Kris picked by comparing beats his weakest holding outright: the pick is his call.
    const chosen = kind === "new" && !!o.allowNew?.has(best.coin.mint);
    if ((empty(now_.s) || now - now_.s.openedAtMs >= c.minHoldMs) && (chosen || best.score > now_.score * c.swapRatio)) return { type: "close", slot: now_.s, reason: `${best.coin.symbol ?? best.coin.mint.slice(0, 6)} looks stronger`, forSwap: true };
  }
  return null;
}

/** Reads Kris's comparison: the thought without its last line, and the coin named there if it was one of the candidates. */
export function readPick(text: string, names: string[]) {
  const m = /PICK:\s*([^\n]*)\s*$/i.exec(text.trim()), thought = text.replace(/\s*PICK:[^\n]*\s*$/i, "").trim();
  const line = (m?.[1] ?? "").replace(/[*`"']/g, "").trim(), sized = /^(.*?)\s+([\d.]+)\s*(?:sol)?\.?$/i.exec(line), said = (sized?.[1] ?? line).replace(/\.$/, "").trim().toLowerCase();
  const size = sized ? Number(sized[2]) : NaN;
  return { thought, pick: names.find(n => n.toLowerCase() === said) ?? null, size: Number.isFinite(size) && size > 0 ? size : null };
}
/** The size Kris asked for, held to the allowance; his default when he named none. */
export const slotSize = (asked: number | null, c: Pick<Config, "budgetSol" | "minSizeSol" | "maxSizeSol"> = SLOT_CONFIG) => Math.min(c.maxSizeSol, Math.max(c.minSizeSol, asked ?? c.budgetSol));
