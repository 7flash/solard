/** Everything the page shows except the selected coin: wallets, bots (with base size and smart-wallet multiplier),
 * discovery (new + migrated), decisions, daemon health. */
import { bridge, readJson } from "../../lib/bridge.ts";
import { closedRows, type ClosedPnl, type ClosedRow } from "../../../../tui/closed-positions.ts";
import { fillsFromLog } from "../../../../tui/fill-log.ts";
import { readFileSync, statSync } from "node:fs";

/** Hourly USD volume from DexScreener, every 5 min in the background: our stream sees only pump.fun and PumpSwap, so
 * a coin trading on Raydium or Meteora would read as $0. */
const dexVol = new Map<string, number>(), dexCap = new Map<string, number>(); let dexAt = 0;
async function refreshDexVol(mints: string[]) {
  if (Date.now() - dexAt < 300_000) return; dexAt = Date.now();
  for (let i = 0; i < mints.length; i += 30) {
    const j = await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mints.slice(i, i + 30).join(",")}`, { signal: AbortSignal.timeout(8_000) })).json().catch(() => null) as { pairs?: { baseToken?: { address?: string }; volume?: { h1?: number } }[] } | null;
    if (!j) continue;
    const sum = new Map<string, number>(); for (const p of j.pairs ?? []) { const m = p.baseToken?.address; if (m) sum.set(m, (sum.get(m) ?? 0) + (p.volume?.h1 ?? 0)); }
    for (const [m, v] of sum) dexVol.set(m, v);
    // Deepest pool's cap: a disabled bot writes no status, so its row would keep the cap from when it stopped.
    const deepest = new Map<string, number>();
    for (const p of (j.pairs ?? []) as { baseToken?: { address?: string }; liquidity?: { usd?: number }; marketCap?: number }[]) { const m = p.baseToken?.address, l = p.liquidity?.usd ?? 0; if (m && p.marketCap && l >= (deepest.get(m) ?? 0)) { deepest.set(m, l); dexCap.set(m, p.marketCap); } }
  }
}

/** Result of closed bots (.range-bots/closed-pnl.jsonl): closing a bot must not make its loss vanish from the total. */
function closedPnl() {
  let sol = 0, bots = 0;
  try { for (const l of readFileSync(new URL("../../../../.range-bots/closed-pnl.jsonl", import.meta.url), "utf8").split("\n")) { if (!l) continue; sol += (JSON.parse(l) as { pnlSol: number }).pnlSol; bots++; } } catch {}
  return { sol, bots };
}

/** Closed positions, rebuilt only when a new close is written. */
let closedCache: { mtimeMs: number; rows: ClosedRow[] } | null = null;
function closedList() {
  try {
    const path = new URL("../../../../.range-bots/closed-pnl.jsonl", import.meta.url), mtimeMs = statSync(path).mtimeMs;
    if (closedCache?.mtimeMs === mtimeMs) return closedCache.rows;
    const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as ClosedPnl), symbols = readJson<Record<string, string>>(".range-bots/symbols.json") ?? {};
    const logs = new Map<string, ReturnType<typeof fillsFromLog>>();
    const fills = (r: ClosedPnl) => { const k = `${r.wallet}-${r.mint}`; if (!logs.has(k)) { let f: ReturnType<typeof fillsFromLog> = []; try { f = fillsFromLog(readFileSync(new URL(`../../../../.range-bots/term-${k}.log`, import.meta.url), "utf8")); } catch {} logs.set(k, f); } return logs.get(k)!; };
    closedCache = { mtimeMs, rows: closedRows(rows, fills, m => symbols[m] ?? null) };
    return closedCache.rows;
  } catch { return []; }
}

/** Last confirmed trade, from the bot's own log: the status file loses it on every daemon restart. Read again only when the log changed. */
const lastTrades = new Map<string, { mtimeMs: number; atMs: number | null }>();
function lastTradeFromLog(wallet: string, mint: string) {
  const path = new URL(`../../../../.range-bots/term-${wallet}-${mint}.log`, import.meta.url);
  try {
    const mtimeMs = statSync(path).mtimeMs, seen = lastTrades.get(path.href);
    if (seen?.mtimeMs === mtimeMs) return seen.atMs;
    const hits = [...readFileSync(path, "utf8").matchAll(/^(\S+Z) .*(?:BUY|SELL) confirmed CONFIRMED/gm)], at = hits.length ? Date.parse(hits[hits.length - 1]![1]!) : null;
    lastTrades.set(path.href, { mtimeMs, atMs: at });
    return at;
  } catch { return null; }
}

type Bot = { wallet: string; mint: string; mode?: string; symbol?: string | null; capUsd?: number | null; range?: { unit: string; buy: number; sell: number } | null;
  steps?: number; holdingSteps?: number; target?: number; budgetSol?: number; valueSol?: number | null; costSol?: number | null; pnlSol?: number | null;
  nextBuy?: number | null; nextSell?: number | null; last?: string | null; alive?: boolean };

export async function GET() {
  const [state, disc] = await Promise.all([
    bridge<{ wallets: unknown[]; bots: Bot[]; solUsd: number | null; at: number }>("/api/state"),
    bridge<{ firehose: unknown; coins: unknown[]; decisions: unknown[] }>("/api/discovery").catch(() => ({ firehose: null, coins: [], decisions: [] })),
  ]);
  const reg = readJson<{ bots?: Array<{ wallet: string; mint: string; amount: string; smart?: boolean; auto?: boolean; buysPaused?: boolean; addedAt?: number; rangeLocked?: boolean }> }>(".range-bots/bots.json");
  const entries = new Map((reg?.bots ?? []).map(b => [`${b.wallet}:${b.mint}`, b]));
  const daemon = readJson<{ feed?: { lagMs?: number } }>(".range-bots/daemon-status.json");
  const vols = readJson<{ coveredMin: number; sol: Record<string, number> }>(".range-bots/volumes.json");
  const bots = state.bots.filter(b => b.mode === "target").map(b => {
    const e = entries.get(`${b.wallet}:${b.mint}`), st = readJson<{ error?: string | null; flowSol?: number; updatedAt?: number; lastTradeAtMs?: number | null }>(`.range-bots/target-${b.wallet}-${b.mint}.json`);
    const base = Number(e?.amount ?? b.budgetSol ?? 0);
    return { ...b, base, mult: base > 0 && b.budgetSol ? Math.round(b.budgetSol / base * 100) / 100 : 1,
      source: e?.smart ? "smart" : e?.auto ? "migration" : "manual", buysPaused: !!e?.buysPaused,
      vol1hSol: Math.max(vols?.sol[b.mint] ?? 0, state.solUsd ? (dexVol.get(b.mint) ?? 0) / state.solUsd : 0), volCoveredMin: vols?.coveredMin ?? null,
      rangeLocked: !!e?.rangeLocked, addedAt: e?.addedAt ?? null, lastTradeAtMs: Math.max(st?.lastTradeAtMs ?? 0, lastTradeFromLog(b.wallet, b.mint) ?? 0) || null,
      error: st?.error ?? null, flowSol: st?.flowSol ?? 0, pnl: (st?.flowSol ?? 0) + (b.valueSol ?? 0), stale: st?.updatedAt ? Date.now() - st.updatedAt > 60_000 : true };
  });
  // Bots in the registry that are not running (isolated to one coin, daemon down): shown faded with their last known numbers.
  const running = new Set(bots.map(b => `${b.wallet}:${b.mint}`)), symbols = readJson<Record<string, string>>(".range-bots/symbols.json") ?? {};
  const inactive = (reg?.bots ?? []).filter(e => (e as { mode?: string }).mode === "target" && !running.has(`${e.wallet}:${e.mint}`)).flatMap(e => {
    const st = readJson<{ range?: Bot["range"]; capUsd?: number | null; priceSol?: number | null; balanceRaw?: string | null; decimals?: number | null; held?: number; steps?: number; budgetSol?: number; flowSol?: number }>(`.range-bots/target-${e.wallet}-${e.mint}.json`);
    if (!st) return [];
    const valueSol = Number(st.balanceRaw ?? 0) / 10 ** (st.decimals ?? 6) * (st.priceSol ?? 0), base = Number(e.amount ?? st.budgetSol ?? 0);
    return [{ wallet: e.wallet, mint: e.mint, mode: "target", symbol: symbols[e.mint] ?? null, capUsd: dexCap.get(e.mint) ?? st.capUsd ?? null, range: st.range ?? null, steps: st.steps, holdingSteps: st.held, budgetSol: st.budgetSol,
      valueSol, priceSol: st.priceSol ?? null, nextBuy: null, nextSell: null, base, mult: 1, source: e.smart ? "smart" : e.auto ? "migration" : "manual", buysPaused: !!e.buysPaused,
      vol1hSol: Math.max(vols?.sol[e.mint] ?? 0, state.solUsd ? (dexVol.get(e.mint) ?? 0) / state.solUsd : 0), volCoveredMin: vols?.coveredMin ?? null, rangeLocked: !!e.rangeLocked, addedAt: e.addedAt ?? null,
      lastTradeAtMs: lastTradeFromLog(e.wallet, e.mint), error: null, flowSol: st.flowSol ?? 0, pnl: (st.flowSol ?? 0) + valueSol, stale: false, inactive: true }];
  });
  void refreshDexVol([...bots, ...inactive].map(b => b.mint)).catch(() => {});
  return Response.json({ at: Date.now(), closed: closedPnl(), closedRows: closedList(), solUsd: state.solUsd, wallets: state.wallets, bots: [...bots, ...inactive], firehose: disc.firehose, coins: disc.coins,
    decisions: disc.decisions.slice(0, 40), feedLagMs: daemon?.feed?.lagMs ?? null }, { headers: { "cache-control": "no-store" } });
}
