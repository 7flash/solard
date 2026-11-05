/** Trader wallet scores from the live trade stream, stored in the main solard SQLite (table traderStats).
 * Daemon side: TraderBook keeps cumulative per-(trader, coin) flows in memory and upserts the changed rows
 * in one transaction every 15s, so a busy stream never turns into per-trade disk writes.
 * Read side: traderScores() turns rows into P&L per trader (realized + open holdings at the last price). */
import type { SolardDatabase } from "../packages/core/src/db/schema.ts";
import type { TradeRow } from "./screen.ts";

type Stat = { statKey: string; trader: string; mint: string; buys: number; sells: number; solIn: number; solOut: number;
  tokensBought: number; tokensSold: number; lastPriceSol: number | null; entryCapUsd?: number | null; exitCapUsd?: number | null; firstAtMs: number; lastAtMs: number };

export class TraderBook {
  private readonly stats = new Map<string, Stat>();
  private readonly dirty = new Set<string>();
  private readonly pending: Array<{ mint: string; row: TradeRow }> = [];
  private readonly seen = new Set<string>(); // signatures: live stream and history replay overlap
  constructor(private readonly db: SolardDatabase, private readonly log: (t: string) => void = () => {}) {
    setInterval(() => this.flush(), 15_000).unref?.();
  }
  /** Tokens this wallet holds in this coin from every trade seen so far, including ones not flushed yet. */
  holding(trader: string, mint: string) {
    const s = this.stats.get(`${trader}:${mint}`);
    let held = s ? s.tokensBought - s.tokensSold : 0;
    for (const p of this.pending) if (p.mint === mint && p.row.trader === trader) held += (p.row.side === "buy" ? 1 : -1) * (p.row.tokens ?? 0);
    return held;
  }
  /** Share of everything this wallet bought in the coin that it still holds (1 = all, 0 = sold out). */
  heldShare(trader: string, mint: string) {
    const s = this.stats.get(`${trader}:${mint}`);
    let bought = s?.tokensBought ?? 0;
    for (const p of this.pending) if (p.mint === mint && p.row.trader === trader && p.row.side === "buy") bought += p.row.tokens ?? 0;
    return bought > 0 ? Math.max(0, this.holding(trader, mint)) / bought : 0;
  }
  /** Every wallet's position in this coin from its full history: the DB rows (all sessions), with the in-memory
   * stats and not-yet-flushed trades of this session on top. bought/held in tokens. */
  positions(mint: string) {
    const out = new Map<string, { bought: number; held: number }>();
    for (const r of this.db.traderStats.select().where({ mint }).all() as Stat[]) out.set(r.trader, { bought: r.tokensBought, held: r.tokensBought - r.tokensSold });
    for (const s of this.stats.values()) if (s.mint === mint) out.set(s.trader, { bought: s.tokensBought, held: s.tokensBought - s.tokensSold });
    for (const p of this.pending) if (p.mint === mint && p.row.trader) {
      const x = out.get(p.row.trader) ?? { bought: 0, held: 0 }, n = p.row.tokens ?? 0;
      if (p.row.side === "buy") { x.bought += n; x.held += n; } else x.held -= n;
      out.set(p.row.trader, x);
    }
    return out;
  }
  /** Every wallet with a recorded trade in this coin. */
  tradersIn(mint: string) { const out = new Set<string>(); for (const s of this.stats.values()) if (s.mint === mint) out.add(s.trader); for (const p of this.pending) if (p.mint === mint && p.row.trader) out.add(p.row.trader); return [...out]; }
  /** Share of supply (1B) held by the buyers of the first 3s after launch, and by the top 10, from seen trades. */
  /** Every wallet row of a coin: saved history plus this session, so a restart does not blank the entry checks. */
  private rowsOf(mint: string) {
    const out = new Map((this.db.traderStats.select().where({ mint }).all() as Stat[]).map(r => [r.trader, r]));
    for (const s of this.stats.values()) if (s.mint === mint) out.set(s.trader, s);
    return [...out.values()];
  }
  /** Did this wallet get its tokens at launch? True if its first recorded buy was within 60s of the coin's first trade, or
   * if we never saw it buy at all (launch-transaction buys and transfers do not reach the trade stream). */
  launchHolder(mint: string) {
    const rows = this.rowsOf(mint), t0 = Math.min(...rows.map(r => r.firstAtMs));
    const first = new Map(rows.filter(r => r.tokensBought > 0).map(r => [r.trader, r.firstAtMs]));
    return (owner: string) => { const at = first.get(owner); return at == null || at - t0 <= 60_000; };
  }
  concentration(mint: string, launchedAtMs: number | null, exclude?: Set<string>) {
    const rows = this.rowsOf(mint).filter(s => !exclude?.has(s.trader));
    const held = rows.map(s => ({ s, held: Math.max(0, s.tokensBought - s.tokensSold) })).sort((a, b) => b.held - a.held);
    const pct = (x: number) => x / 1e9 * 100;
    const t0 = launchedAtMs ?? Math.min(...rows.map(r => r.firstAtMs));
    return { wallets: rows.length, top10Pct: pct(held.slice(0, 10).reduce((a, h) => a + h.held, 0)),
      earlyPct: pct(held.filter(h => h.s.firstAtMs - t0 <= 3_000).reduce((a, h) => a + h.held, 0)) };
  }
  add(mint: string, row: TradeRow) {
    if (!row.trader || !row.side || row.sol == null || row.tokens == null || !(row.sol > 0)) return;
    const id = `${row.signature}:${row.trader}:${row.side}:${row.tokens}`;
    if (this.seen.has(id)) return;
    this.seen.add(id); if (this.seen.size > 500_000) this.seen.clear();
    this.pending.push({ mint, row });
  }
  flush() {
    if (!this.pending.length) return;
    const batch = this.pending.splice(0);
    try {
      this.db.transaction(() => {
        for (const { mint, row } of batch) {
          const key = `${row.trader}:${mint}`;
          let s = this.stats.get(key);
          if (!s) {
            s = (this.db.traderStats.select().where({ statKey: key }).first() as Stat | undefined) ?? {
              statKey: key, trader: row.trader!, mint, buys: 0, sells: 0, solIn: 0, solOut: 0, tokensBought: 0, tokensSold: 0,
              lastPriceSol: null, firstAtMs: row.atMs, lastAtMs: row.atMs };
            this.stats.set(key, s);
          }
          if (row.side === "buy") { s.buys++; s.solIn += row.sol!; s.tokensBought += row.tokens!; if (s.entryCapUsd == null && row.capUsd != null) s.entryCapUsd = row.capUsd; }
          else { s.sells++; s.solOut += row.sol!; s.tokensSold += row.tokens!; if (row.capUsd != null) s.exitCapUsd = row.capUsd; }
          s.lastPriceSol = row.sol! / row.tokens!; s.lastAtMs = Math.max(s.lastAtMs, row.atMs);
          this.dirty.add(key);
        }
        for (const key of this.dirty) {
          const { statKey, trader, mint, buys, sells, solIn, solOut, tokensBought, tokensSold, lastPriceSol, firstAtMs, lastAtMs } = this.stats.get(key)!;
          const entryCapUsd = this.stats.get(key)!.entryCapUsd ?? null, exitCapUsd = this.stats.get(key)!.exitCapUsd ?? null;
          this.db.traderStats.upsert({ statKey, trader, mint, buys, sells, solIn, solOut, tokensBought, tokensSold, lastPriceSol, entryCapUsd, exitCapUsd, firstAtMs, lastAtMs }, {
            on: "statKey",
            merge: t => ({ buys: t.excluded("buys"), sells: t.excluded("sells"), solIn: t.excluded("solIn"), solOut: t.excluded("solOut"),
              tokensBought: t.excluded("tokensBought"), tokensSold: t.excluded("tokensSold"), lastPriceSol: t.excluded("lastPriceSol"),
              entryCapUsd: t.excluded("entryCapUsd"), exitCapUsd: t.excluded("exitCapUsd"),
              lastAtMs: t.excluded("lastAtMs") }),
          });
        }
      });
      this.dirty.clear();
      if (this.stats.size > 200_000) this.stats.clear(); // reload from the DB on next sight
    } catch (error) { this.log(`trader book flush failed: ${error instanceof Error ? error.message : error}`); }
  }
}

export type TraderScore = { trader: string; pnlSol: number; realizedSol: number; coins: number; wins: number; trades: number; solIn: number };

/** P&L per trader across every coin we have streamed: SOL out - SOL in + open tokens at the coin's last price. */
export function traderScores(db: SolardDatabase, traders?: string[]): Map<string, TraderScore> {
  const rows = (traders?.length
    ? traders.flatMap(trader => db.traderStats.select().where({ trader }).all() as Stat[])
    : db.traderStats.select().all() as Stat[]);
  const out = new Map<string, TraderScore>();
  for (const r of rows) {
    const open = Math.max(0, r.tokensBought - r.tokensSold) * (r.lastPriceSol ?? 0);
    const pnl = r.solOut - r.solIn + open;
    const s = out.get(r.trader) ?? { trader: r.trader, pnlSol: 0, realizedSol: 0, coins: 0, wins: 0, trades: 0, solIn: 0 };
    s.pnlSol += pnl; s.realizedSol += r.solOut - r.solIn; s.coins++; if (pnl > 0) s.wins++; s.trades += r.buys + r.sells; s.solIn += r.solIn;
    out.set(r.trader, s);
  }
  return out;
}
