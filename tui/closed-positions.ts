/** Closed positions for the terminal: the saved result of each close, joined with that coin's fills from its log. */
import type { LogFill } from "./fill-log.ts";

export type ClosedPnl = { at: number; wallet: string; mint: string; pnlSol: number };
export type ClosedRow = { mint: string; symbol: string | null; closedAt: number; openedAt: number | null; boughtSol: number; buys: number; sells: number; pnlSol: number; pct: number | null };

/** Newest first. A coin closed twice counts each fill once: each close takes the fills since the one before it. */
export function closedRows(rows: ClosedPnl[], fillsOf: (r: ClosedPnl) => LogFill[], symbolOf: (mint: string) => string | null, limit = 100): ClosedRow[] {
  const lastClose = new Map<string, number>(), out: ClosedRow[] = [];
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    const since = lastClose.get(r.mint) ?? 0, fills = fillsOf(r).filter(f => f.atMs > since && f.atMs <= r.at); lastClose.set(r.mint, r.at);
    const buys = fills.filter(f => f.side === "buy"), boughtSol = buys.reduce((a, f) => a + f.sol, 0);
    out.push({ mint: r.mint, symbol: symbolOf(r.mint), closedAt: r.at, openedAt: fills.length ? Math.min(...fills.map(f => f.atMs)) : null, boughtSol, buys: buys.length, sells: fills.length - buys.length, pnlSol: r.pnlSol, pct: boughtSol > 0 ? r.pnlSol / boughtSol * 100 : null });
  }
  return out.reverse().slice(0, limit);
}
