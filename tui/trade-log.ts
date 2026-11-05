/** Live trades per coin, shared from the slrd-bots daemon (which already streams every coin) to the TUI:
 * .range-bots/trades/<mint>.json holds the newest trades, newest first. One SQD stream for everything. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TradeEvent } from "../packages/core/src/market/launch-trades.ts";
import type { TradeRow } from "./screen.ts";

const SOL = "So11111111111111111111111111111111111111112";
export const tradesDir = (root: string) => join(root, ".range-bots", "trades");
export const tradesPath = (root: string, mint: string) => join(tradesDir(root), `${mint}.json`);

export function toTradeRow(e: TradeEvent): TradeRow {
  const quoteIsSol = e.market.quoteMint === SOL;
  const quote = e.quoteRaw == null ? null : Number(e.quoteRaw) / 10 ** e.market.quoteDecimals;
  return {
    signature: e.signature, atMs: e.atMs, side: e.side,
    sol: quote == null ? null : quoteIsSol ? quote : e.market.priceSol != null && e.baseRaw != null ? Number(e.baseRaw) / 10 ** e.market.baseDecimals * e.market.priceSol : null,
    tokens: e.baseRaw == null ? null : Number(e.baseRaw) / 10 ** e.market.baseDecimals,
    capUsd: e.market.marketCapUsd ?? (e.market.marketCapSol != null && e.market.solUsd != null ? e.market.marketCapSol * e.market.solUsd : null),
    trader: e.trader ?? null, creator: e.creator ?? null,
  };
}

/** Daemon side: keep the newest `keep` trades per coin, write changed coins at most once a second. */
export class TradeLog {
  private readonly rows = new Map<string, TradeRow[]>();
  private readonly dirty = new Set<string>();
  private readonly seen = new Set<string>();
  constructor(private readonly root: string, private readonly keep = 300) {
    mkdirSync(tradesDir(root), { recursive: true });
    setInterval(() => this.flush(), 1_000).unref?.();
  }
  add(e: TradeEvent) { this.addRow(e.mint, toTradeRow(e), `${e.signature}:${e.logIndex ?? e.eventIndex ?? 0}`); }
  /** Firehose rows (pump.fun + PumpSwap coins no longer go through the per-coin SQD feed). */
  addRow(mint: string, row: TradeRow, key = `${row.signature}:${row.trader}:${row.side}:${row.tokens}`) {
    if (this.seen.has(key)) return;
    this.seen.add(key); if (this.seen.size > 50_000) this.seen.clear();
    let list = this.rows.get(mint);
    if (!list) { list = this.load(mint); this.rows.set(mint, list); }
    list.unshift(row); if (list.length > this.keep) list.length = this.keep;
    this.dirty.add(mint);
  }
  private load(mint: string): TradeRow[] { return readTrades(this.root, mint).slice(0, this.keep); }
  private flush() {
    for (const mint of this.dirty) {
      const path = tradesPath(this.root, mint);
      try { writeFileSync(`${path}.tmp`, JSON.stringify(this.rows.get(mint) ?? [])); renameSync(`${path}.tmp`, path); } catch {}
    }
    this.dirty.clear();
  }
}

/** TUI side. */
export function readTrades(root: string, mint: string): TradeRow[] {
  try { return JSON.parse(readFileSync(tradesPath(root, mint), "utf8")) as TradeRow[]; } catch { return []; }
}
