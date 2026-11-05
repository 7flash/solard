/**
 * slrd-bots: every range bot in ONE process.
 *
 *   bunx bgrun --name slrd-bots --directory C:/Code/solwal "bun run slrd-bots.ts"
 *
 * - follows .range-bots/bots.json (slrd-tui `n` / range-term add entries)
 * - one SQD trade subscription prices every bot (RPC fallback + 30s cross-check)
 * - one shared client: one blockhash refresher, one RPC budget, one dead-key view
 * - per-bot control files ranges/<wallet>-<mint>.cmd: resume | stop (sell 100% + close) | kill (keep)
 * - per-bot engine log: .range-bots/term-<wallet>-<mint>.log (same files the terminal bots used)
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspect } from "node:util";
import { configure } from "measure-fn";
import { activateRpc } from "./packages/cli/src/rpc-management.ts";
import { withTradeRpcPriority } from "./packages/core/src/chain/rpc-priority.ts";
import { rpcSchedulerStats } from "./packages/core/src/chain/rpc-scheduler.ts";
import { rpcPoolStatuses, takeSlowRpc } from "./packages/core/src/chain/connection.ts";

/** A smart bot that has not bought within SLRD_SMART_FILL_MIN (10) minutes of its signal is removed: the signal is
 * stale by then (Miguel bought 56 min late, after its signal wallets had left, and sold at a loss). */
setInterval(() => {
  const limit = Number(process.env.SLRD_SMART_FILL_MIN ?? 10) * 60_000;
  for (const r of running.values()) {
    if (!r.entry.smart || r.exit || !r.target || Date.now() - (r.entry.addedAt ?? Date.now()) < limit) continue;
    const st = r.target.status;
    if (st.balanceRaw !== "0" || Math.abs(st.flowSol) > 0) continue; // filled (or unknown): keep
    log(`${key(r.entry)}: smart signal not filled within ${limit / 60_000} min: removing (signal stale)`);
    r.exit = "keep"; removeBot(root, r.entry.wallet, r.entry.mint); void finish(r);
  }
}, 60_000).unref?.();
/** Ranges the price has left are moved back around it: out for SLRD_RECENTER_OUT_MIN (5) minutes -> 0.7x-1.6x of the
 * cap in 3 steps, size reset to the tokens really held so the move itself never trades (see tui/recenter.ts). Skipped:
 * locked ranges, and ranges edited in the last 30 min (those are yours). SLRD_RECENTER=0 turns it off. */
const outSince = new Map<string, number>();
/** The hour of volume that survives restarts (volumes.json); the firehose alone only knows since it started. */
const vol1hSaved = (mint: string) => { try { return (JSON.parse(readFileSync(resolve(root, ".range-bots", "volumes.json"), "utf8")) as { sol?: Record<string, number> }).sol?.[mint] ?? 0; } catch { return 0; } };
setInterval(() => {
  if (process.env.SLRD_RECENTER === "0" || onlyMints()) return;
  const now = Date.now(), outMs = Number(process.env.SLRD_RECENTER_OUT_MIN ?? 5) * 60_000, line = Number(process.env.SLRD_DEAD_CAP_USD ?? 3_000);
  for (const r of running.values()) {
    const t = r.target, e = r.entry, k = key(e); if (!t || r.exit || r.switching) continue;
    const s = t.status as typeof t.status & { capUsd?: number; priceSol?: number; balanceRaw?: string; decimals?: number };
    if (e.rangeLocked || s.inFlight || s.error || !s.capUsd || !s.priceSol || s.balanceRaw == null || s.decimals == null || now - s.updatedAt > 60_000) { outSince.delete(k); continue; }
    let range: TargetRange; try { range = targetRange(e); } catch { continue; }
    // A bag already moved under its cost is corrected at once: it must not sell there (Groyper sold at $60k after buys at $75-132k).
    const tokens = Number(s.balanceRaw) / 10 ** s.decimals, even = breakEvenCap({ capUsd: s.capUsd, priceSol: s.priceSol, tokens, flowSol: s.flowSol ?? 0 });
    const sellsUnderCost = !!e.baseAmount && !!even && range.sell < even * 0.97;
    if (!sellsUnderCost && (range.unit !== "usd" || (s.capUsd >= range.buy && s.capUsd <= range.sell))) { outSince.delete(k); continue; }
    const since = outSince.get(k) ?? outSince.set(k, now).get(k)!;
    if (!sellsUnderCost) {
      if (now - since < outMs) continue;
      try { if (now - statSync(rangePath(e)).mtimeMs < 30 * 60_000) continue; } catch { continue; }
    }
    const base = Number(e.baseAmount ?? e.amount);
    const m = recenter({ capUsd: s.capUsd, priceSol: s.priceSol, balanceRaw: BigInt(s.balanceRaw), decimals: s.decimals, baseSol: base, floorCapUsd: line, band: candles.band(e.mint), flowSol: s.flowSol ?? 0,
      volSol1h: vol1hSaved(e.mint), maxSol: Number(process.env.SLRD_MAX_SIZE_SOL ?? 0.2) });
    if (!m) continue;
    // Same synchronous block: a tick must never see the new range with the old size.
    const p = rangePath(e); writeFileSync(`${p}.tmp`, rangeFileBody("usd", String(m.buy), String(m.sell), m.steps).text); renameSync(`${p}.tmp`, p);
    // A moved bag only sells: its size is sized to the tokens, so dip buys would average down with new SOL. Once empty it
    // comes back at base size with buys on.
    const patch = { amount: String(m.budgetSol), baseAmount: String(base), buysPaused: m.holding };
    updateBot(root, e.wallet, e.mint, patch);
    r.sizeMult = 1; r.entry = { ...e, ...patch }; t.setBuysPaused(m.holding); t.rebase(m.budgetSol, !m.holding); outSince.delete(k);
    log(`${k}: RECENTER cap ${Math.round(s.capUsd)} was outside ${range.buy}-${range.sell} -> ${m.buy}-${m.sell} x${m.steps}, size ${m.budgetSol} SOL (${m.holding ? "matched to the bag, no trade" : "empty, base size"})`);
  }
}, 20_000).unref?.();
/** Size scales mildly with the followable wallets in each coin (every 2 min): 3+ holding and more holding than sold
 * out -> x1.5 (at most 0.1 SOL), otherwise x1. Never below your size: buys and sells are the range's decision. */
setInterval(() => {
  const follow = smart?.followed(); if (!follow?.size) return;
  for (const r of running.values()) {
    if (!r.target || r.exit) continue;
    if (r.entry.baseAmount && Number(r.entry.amount) !== Number(r.entry.baseAmount)) continue; // sized to its bag: no extra buys
    const mint = r.entry.mint, base = Number(r.entry.amount);
    const pos = traderBook.positions(mint), smartIn = [...pos].filter(([t, p]) => follow.has(t) && p.bought > 0);
    if (!smartIn.length) continue;
    const share = smartIn.map(([, p]) => Math.max(0, p.held) / p.bought);
    const holders = share.filter(x => x >= 0.2).length, out = share.filter(x => x < 0.2).length;
    // Up only and mild (x1.5): followable wallets never force a sale (no downsizing) and never decide a trade alone.
    let mult = holders >= 3 && holders > out ? 1.5 : 1;
    if (mult > 1) mult = Math.max(1, Math.min(mult, 0.1 / base));
    mult = Math.round(mult * 100) / 100;
    if (mult !== (r.sizeMult ?? 1)) { log(`${key(r.entry)}: size x${mult} (${holders} followable wallets holding, ${out} sold out)`); r.sizeMult = mult; }
  }
}, 120_000).unref?.();
// Event-loop lag: a 100ms timer that fires late means the process was blocked (sync SQLite, CPU).
let loopLagMax = 0, loopLagTotal = 0, loopTick = Date.now();
let memPeak = 0;
let memTold = false;
setInterval(() => {
  const m = process.memoryUsage(), rss = m.rss / 1e9; if (!(rss > memPeak * 1.25 && rss > 1)) return;
  memPeak = rss; log(`memory ${rss.toFixed(1)} GB (new high): heap ${(m.heapUsed / 1e9).toFixed(2)}, external ${(m.external / 1e9).toFixed(2)}, buffers ${(m.arrayBuffers / 1e9).toFixed(2)}`);
  if (rss > 3 && !memTold) { memTold = true; void import("bun:jsc").then(j => { const c = j.heapStats().objectTypeCounts as Record<string, number>; log(`memory by type: ${Object.entries(c).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(" ")}`); }).catch(() => {}); }
}, 1_000).unref?.();
setInterval(() => { const lag = Date.now() - loopTick - 100; loopTick = Date.now(); if (lag > 0) { loopLagTotal += lag; loopLagMax = Math.max(loopLagMax, lag); } }, 100).unref?.();
// Every 30s: queue depth per quota group and each pool's benched endpoints (why RPC stalls).
setInterval(() => {
  const groups = rpcSchedulerStats().map(g => `${g.group}: ${g.active} active, ${g.queued} queued (${g.urgent} urgent)`).join(" | ");
  const now = Date.now(), benched = new Map<string, number>();
  for (const rows of rpcPoolStatuses()) for (const r of rows) if (r.cooldownUntil > now) benched.set(`${r.group} ${(r.lastReason ?? "").slice(0, 60)}`, (benched.get(`${r.group} ${(r.lastReason ?? "").slice(0, 60)}`) ?? 0) + 1);
  log(`rpc queue: ${groups} || pools ${rpcPoolStatuses().length}, benched: ${[...benched].map(([k, n]) => `${n}x ${k}`).join("; ") || "none"} || event loop blocked ${(loopLagTotal / 1000).toFixed(1)}s of 30s, worst ${loopLagMax}ms`);
  loopLagMax = 0; loopLagTotal = 0;
  const cp = chainPrices.stats(); log(`chain prices: ${cp.priced}/${cp.coins} coins fresh, last round ${cp.lastRoundMs}ms (${cp.sinceRoundMs}ms ago), ${chainPrices.calls} calls${cp.errors ? `, errors: ${cp.errors}` : ""}`); chainPrices.calls = 0;
  const slowList = takeSlowRpc();
  if (slowList.length) log(`rpc slow (>3s) x${slowList.length}: ${slowList.slice(-6).join(" | ")}`);
}, 30_000).unref?.();
import { PublicKey } from "@solana/web3.js";
import type { MarketPrice } from "./packages/core/src/venues/venue-plugin.ts";
import { SolardConnection } from "./packages/core/src/chain/connection.ts";
import { createSolard } from "./packages/sdk/src/index";
import { addBot, daemonPid, daemonPidPath, readRegistry, removeBot, updateBot, type BotEntry } from "./tui/bot-registry.ts";
import { exitPosition } from "./tui/exit-position.ts";
import { parseRangeFile, parseRangeSteps } from "./packages/core/src/runtime/range-file.ts";
import { rangeBounds, rangeFileBody } from "./packages/core/src/runtime/range-commands.ts";
import { splitAmount, stepRungs } from "./packages/core/src/runtime/range-steps.ts";
import { SqdPriceFeed } from "./tui/sqd-price-feed.ts";
import { buyRoom } from "./tui/sol-floor.ts";
import { observeSolardRpc } from "./packages/core/src/chain/rpc-observer.ts";
import { TradeLog, readTrades } from "./tui/trade-log.ts";
import { startMigrationWatcher, decisions, decide } from "./tui/migration-watcher.ts";
import { startSmartEntry } from "./tui/smart-entry.ts";
import { ChainPrices } from "./tui/chain-prices.ts";
import { WalletBalances } from "./tui/wallet-balances.ts";
import { Holders } from "./tui/holders.ts";
import { bondingCurvePda } from "./packages/core/src/venues/pump/pda.ts";
import { entryGuard } from "./tui/entry-guard.ts";
import { holderVeto, topHolders } from "./tui/top-holders.ts";
import { TraderBook } from "./tui/trader-book.ts";
import { Firehose, volume1h } from "./tui/firehose.ts";
import { breakEvenCap, recenter } from "./tui/recenter.ts";
import { Candles } from "./tui/candles.ts";
import { curveRange, curveSignal } from "./tui/curve-entry.ts";
import { getSolUsdPrice, quoteSolLoader } from "./packages/core/src/market/launch-trades.ts";
import { readMint } from "./packages/core/src/chain/state.ts";
import { toTradeRow } from "./tui/trade-log.ts";
import { openDatabase } from "./packages/core/src/db/database.ts";
import { TargetBot, type TargetRange } from "./tui/target-bot.ts";

const root = import.meta.dir;
const candles = new Candles(root);
process.chdir(root); // the engine keeps locks relative to cwd
const configToml = resolve(root, ".config.toml");
if (existsSync(configToml)) {
  const slrd = (Bun.TOML.parse(readFileSync(configToml, "utf8")) as Record<string, Record<string, unknown>>).slrd ?? {};
  for (const [key, value] of Object.entries(slrd)) {
    const name = `SLRD_${key}`.toUpperCase();
    if (process.env[name] === undefined && value != null && typeof value !== "object") process.env[name] = String(value);
  }
}
activateRpc(new Map());
// Trades jump the RPC queue (rpc-scheduler urgent tickets). Mode "1" additionally throttled every other request
// to one per 1.1s while any priority task ran; with prepared orders and new signal bots that is nearly always, and
// every price and balance read crawled (15-45s waits on an idle queue). Queue-jumping alone is enough.
// Our endpoints are configured mainnet URLs. The readiness probe queues behind normal traffic, times out
// under load and benches healthy endpoints until every read fails; real failures are still classified per request.
process.env.SLRD_RPC_VERIFY_MAINNET = "0";
// Background reads (registration, balances, metadata) wait their turn instead of failing at 15s.
process.env.SLRD_RPC_QUEUE_TIMEOUT_MS ??= "60000";
const rpcUrl = process.env.RPC_ENDPOINT;
if (!rpcUrl) throw Error("No RPC configured: `slrd rpc add http <url>`");

mkdirSync(resolve(root, ".range-bots"), { recursive: true });
const other = daemonPid(root);
if (other && other !== process.pid) throw Error(`slrd-bots already running (pid ${other})`);
writeFileSync(daemonPidPath(root), String(process.pid));

// ---- logging: daemon log + one engine log per bot, routed by measure scope ----
const daemonLog = resolve(root, ".range-bots", "slrd-bots.log");
const write = (path: string, text: string) => { try { appendFileSync(path, `${new Date().toISOString()} ${text}\n`); } catch {} };
const log = (text: string) => { write(daemonLog, text); process.stdout.write(`${new Date().toLocaleTimeString()} ${text}\n`); };
const scopeLog = new Map<string, string>(); // "range-<mint8>" -> log path
const botLogPath = (b: { wallet: string; mint: string }) => resolve(root, ".range-bots", `term-${b.wallet}-${b.mint}.log`);
configure({ logger: ((event: { type: string; label: string; scope?: string; duration?: number; error?: unknown }) => {
  const path = (event.scope && scopeLog.get(event.scope.split(/[ >/]/)[0]!)) ?? daemonLog;
  write(path, `${event.type} ${event.scope ?? ""} ${event.label}${event.duration != null ? ` ${Math.round(event.duration)}ms` : ""}${event.type === "error" ? ` ${String((event.error as Error)?.message ?? event.error)}` : ""}`);
  if (event.type === "annotation" && /^(BUY|SELL) (signal|confirmed|failed)|^Broadcast submitted|^POSITION GONE|^NEW BUYS PAUSED|^Range updated/.test(event.label))
    log(`${event.scope ?? ""} ${event.label.slice(0, 200)}`);
}) as never });
for (const name of ["log", "info", "warn", "error", "debug"] as const)
  console[name] = (...xs: unknown[]) => write(daemonLog, xs.map(x => typeof x === "string" ? x : inspect(x, { depth: 3 })).join(" "));

// ---- shared infrastructure ----
const client = createSolard({ transactionVersion: 1, rpcUrl });
const connection = new SolardConnection(rpcUrl).get();
// What the daemon asks the RPC for: one line a minute, per method, HTTP requests actually sent.
const rpcCounts = new Map<string, number>();
observeSolardRpc(event => { if (event.kind === "http" && (event.phase === "completed" || event.phase === "failed")) {
  const k = `${event.method}${event.phase === "failed" ? "!" : ""}`; rpcCounts.set(k, (rpcCounts.get(k) ?? 0) + Math.max(1, event.requestCount)); } });
setInterval(() => { const rows = [...rpcCounts].sort((a, b) => b[1] - a[1]); const total = rows.reduce((a, [, n]) => a + n, 0);
  log(`rpc/min ${total} (${(total / 60).toFixed(1)}/s): ${rows.slice(0, 12).map(([m, n]) => `${m}=${n}`).join(" ")}`); rpcCounts.clear(); }, 60_000).unref?.();
// SLRD_RPC_TRACE=0 disables: which code calls the RPC (first app frame of the stack at call time), one line a minute.
if (process.env.SLRD_RPC_TRACE !== "0") {
  const { Connection } = await import("@solana/web3.js");
  const callers = new Map<string, number>();
  const frame = () => (new Error().stack ?? "").split("\n").slice(3).map(l => l.trim())
    .filter(l => !/node_modules|web3\.js|chain[\\/]connection\.ts|rpc-(pool|gate|observer)/.test(l)).slice(0, Number(process.env.SLRD_RPC_TRACE_DEPTH ?? 6))
    .map(l => (l.match(/([\w.-]+\.ts):(\d+)/) ?? []).slice(1, 3).join(":") || l.slice(0, 40)).join(" < ");
  for (const m of ["getAccountInfo", "getMultipleAccountsInfo", "getMultipleAccountsInfoAndContext", "getAccountInfoAndContext", "getTokenAccountsByOwner", "getParsedTokenAccountsByOwner", "getTransaction", "getParsedTransaction", "getProgramAccounts", "getBalance", "getTokenSupply", "getLatestBlockhash"] as const) {
    const orig = (Connection.prototype as any)[m]; if (typeof orig !== "function") continue;
    (Connection.prototype as any)[m] = function (...args: unknown[]) { const k = `${m} ${frame()}`; callers.set(k, (callers.get(k) ?? 0) + 1); return orig.apply(this, args); };
  }
  setInterval(() => { const rows = [...callers].sort((a, b) => b[1] - a[1]).slice(0, 15); log(`rpc callers/min: ${rows.map(([k, n]) => `${n} ${k}`).join(" | ")}`); callers.clear(); }, 60_000).unref?.();
}
const feed = new SqdPriceFeed({ connection, rpcSample: mint => client.samplePrice(mint), log,
  // Prices come from SQD. The RPC cross-check is a full pool read (~5 calls): every 2 min x 58 coins was most
  // of the RPC quota. Every trade re-quotes on chain anyway, so a slow check is enough to catch a broken feed.
  verifyMs: Number(process.env.SLRD_PRICE_VERIFY_MS ?? 600_000),
  // The SQD portal can run 20-60s behind for us (throttled); trades re-quote on chain anyway, so a 55s-old stream
  // price beats an RPC read that times out. Bots accept up to SLRD_MAX_PRICE_AGE_MS (60s).
  maxAgeMs: Number(process.env.SLRD_MAX_PRICE_AGE_MS ?? 60_000) - 5_000,
  // Every trade on a coin wakes its target bots at once, so short wicks are acted on within ~0.5s of SQD.
  onTrade: event => { tradeLog.add(event); for (const r of running.values()) if (r.entry.mint === event.mint) r.target?.wake(); } });
const tradeLog = new TradeLog(root);
// Every trader wallet seen on our coins, scored in the main SQLite (traderStats).
const statsDb = openDatabase(process.env.SLRD_DB_PATH);
const traderBook = new TraderBook(statsDb, log);
// Every pump.fun + PumpSwap trade (one SQD log stream, no RPC): wallet scores from first-hand history of
// every coin since launch, so we can follow good wallets into coins long before they migrate.
let firehoseSolUsd: number | null = null;
/** Every bot's coin priced from chain in one batched read every 3s (tui/chain-prices.ts): the primary price source,
 * independent of the SQD portal. Streams remain for discovery, wallets and instant wake-ups. */
/** Exact holders + transfers (tui/holders.ts) for bot coins and coins opened on the web page
 * (.range-bots/holders-watch.json, written by the bridge). Pools and the bonding curve are not holders. */
const holders = new Holders({ root, log,
  launchBlock: mint => firehose.coins.get(mint)?.launchBlock ?? null,
  pools: mint => {
    const out: string[] = [];
    try { out.push(bondingCurvePda(new PublicKey(mint)).toBase58()); } catch {}
    const c = firehose.coins.get(mint); if (c?.mainPool) out.push(c.mainPool);
    try { const t = client.resolveToken(mint) as { pool?: string | null }; if (t.pool) out.push(t.pool); } catch {}
    return out;
  } }).start();
setInterval(() => {
  try {
    const want = JSON.parse(readFileSync(resolve(root, ".range-bots", "holders-watch.json"), "utf8")) as Array<{ mint: string; at: number }>;
    for (const w of want) if (Date.now() - w.at < 30 * 60_000 && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w.mint)) holders.watch(w.mint, 6, true); // opened on a page: backfill first
  } catch {}
}, 5_000).unref?.();
const walletBalances = new WalletBalances({ connection, log, wrap: withTradeRpcPriority });
// The trade stream carries the reserves, and no trade means no price change, so chain is only read when the stream is
// behind or has no price (a round with nothing to read costs no RPC), plus each coin every 5 min as a cross-check.
const chainPrices = new ChainPrices({ connection, log, wrap: withTradeRpcPriority, intervalMs: Number(process.env.SLRD_CHAIN_PRICE_MS ?? 10_000),
  needs: mint => !firehosePrice(mint), recheckMs: Number(process.env.SLRD_CHAIN_RECHECK_MS ?? 300_000),
  resolve: mint => { try { return client.resolveToken(mint) as never; } catch { return null; } } });
/** Price straight from the firehose (SQD log stream, no RPC) for pump.fun coins it is watching: the last trade's
 * pool price, valid up to the newest block it has processed. A brand-new coin has this within seconds, while
 * the per-coin SQD feed first needs its pool resolved over RPC (and on a jammed RPC the bot got no price at all). */
/** Last price of each bot's coin from its previous status file: a coin with no trade since the restart has not
 * moved, so its last price stands, as long as the firehose sees this coin's trades (known pool, or still on the
 * bonding curve, whose trades carry the mint). The first trade replaces it. Every trade re-quotes on chain. */
const seeds = new Map<string, { priceSol: number; capUsd: number | null; migrated: boolean }>();
function seedPrice(mint: string, prev: { priceSol?: number | null; capUsd?: number | null; updatedAt?: number } | null) {
  if (prev?.priceSol && prev.priceSol > 0 && Date.now() - (prev.updatedAt ?? 0) < 30 * 60_000) {
    seeds.set(mint, { priceSol: prev.priceSol, capUsd: prev.capUsd ?? null, migrated: firehose.hasPool(mint) }); return;
  }
  // No usable status (the bot failed before its first price): the coin's last recorded trade.
  const last = readTrades(root, mint).find(t => t.capUsd && t.capUsd > 0);
  if (last?.capUsd && firehoseSolUsd && Date.now() - last.atMs < 6 * 3_600_000)
    seeds.set(mint, { priceSol: last.capUsd / firehoseSolUsd / 1e9, capUsd: last.capUsd, migrated: firehose.hasPool(mint) });
}
function firehosePrice(mint: string): MarketPrice | null {
  const c = firehose.coins.get(mint), s = firehose.stats, solUsd = firehoseSolUsd;
  if (!solUsd || !mint.endsWith("pump") || !s.lastBlockMs || Date.now() - s.lastBlockMs > 15_000) return null; // fresh only (actual age; lagMs freezes when the stream stalls): else solard's per-coin stream
  const read = chainPrices.price(mint, 6 * 60_000), chain = read && (read.quoteAsset as { kind?: string }).kind === "native-sol" ? read : null;
  if (!c) {
    const seed = seeds.get(mint);
    // Below ~$60k a pump coin without a known pool is still on the curve (curve trades always reach the firehose).
    if (!seed || !(seed.migrated || (seed.capUsd ?? Infinity) < 60_000)) return null;
    return { venue: (seed.migrated ? "pumpswap" : "pump-curve") as MarketPrice["venue"], mint: new PublicKey(mint),
      quoteAsset: { kind: "native-sol" } as MarketPrice["quoteAsset"], priceQuotePerToken: chain?.priceQuotePerToken ?? seed.priceSol, capturedAtMs: s.lastBlockMs };
  }
  // Curve and PumpSwap reserves from the last trade (virtual quote included, as launch-trades prices them). A quiet coin
  // has not moved, so the price stands however old the trade is; a newer chain read wins (the 5 min cross-check).
  if (!c.priceSol) return null;
  return { venue: (c.migrated ? "pumpswap" : "pump-curve") as MarketPrice["venue"], mint: new PublicKey(mint),
    quoteAsset: { kind: "native-sol" } as MarketPrice["quoteAsset"], priceQuotePerToken: chain && chain.capturedAtMs > c.lastTradeMs ? chain.priceQuotePerToken : c.priceSol, capturedAtMs: s.lastBlockMs };
}
setInterval(() => void getSolUsdPrice().then(p => { firehoseSolUsd = p.price; }).catch(() => {}), 30_000);
void getSolUsdPrice().then(p => { firehoseSolUsd = p.price; }).catch(() => {});
// Buy any coin (curve or migrated) when 2+ followable wallets buy it: see tui/smart-entry.ts.
/** Every automatic entry: holder concentration + a live sell quote (honeypot) before the bot is opened. */
/** .range-bots/only.json, a list of mints: run only those, for when RPC is short. The rest stay in the registry and their
 * bags in the wallet; the bridge's enable and disable actions edit it. No file or an empty list: everything runs. */
function onlyMints(): string[] | null {
  try { const list = JSON.parse(readFileSync(resolve(root, ".range-bots", "only.json"), "utf8")) as string[]; return list.length ? list : null; } catch { return null; }
}
const isolated = (list: BotEntry[]) => { const only = onlyMints(); return only ? list.filter(b => only.includes(b.mint)) : list; };
/** Free SOL of the auto-entry wallet (cached 30s): no new automatic entry below SLRD_SOL_RESERVE (0.05 SOL). With
 * budgets well above the capital, new bots waited an hour for SOL freed by others and then bought late. */
const freeSolByWallet = new Map<string, { sol: number; at: number }>();
async function walletFreeSol(wallet: string, maxAgeMs = 30_000) {
  const seen = freeSolByWallet.get(wallet);
  if (seen && Date.now() - seen.at < maxAgeMs) return seen.sol;
  const lamports = await connection.getBalance(new PublicKey(client.walletAddress(wallet)), "confirmed");
  freeSolByWallet.set(wallet, { sol: lamports / 1e9, at: Date.now() }); return lamports / 1e9;
}
const guard = async (mint: string, stepSol: number) => {
  if (onlyMints()) return "isolated: new entries are off";
  const autoWallet = process.env.SLRD_AUTO_WALLET ?? readRegistry(root)[0]?.wallet;
  if (autoWallet) {
    const free = await walletFreeSol(autoWallet).catch(() => null), reserve = Number(process.env.SLRD_SOL_RESERVE ?? 0.05);
    if (free != null && free < Math.max(reserve, stepSol + 0.003)) return `wallet SOL low: ${free.toFixed(4)} SOL free (reserve ${reserve})`;
  }
  // Real holders from the chain, first: the stream misses launch-transaction buys and the older check skips thin coins.
  for (let attempt = 1; attempt <= 2; attempt++) try {
    const veto = holderVeto(await withTradeRpcPriority(() => topHolders(connection, mint)), smart?.relays(), traderBook.launchHolder(mint));
    if (veto) return veto;
    break;
  } catch (error) { if (attempt === 2) log(`entry check ${mint.slice(0, 6)}: top holders unavailable: ${String(error).slice(0, 100)}`); }
  await ensureToken(mint); // quoteSell needs the token registered; the bot needs it anyway
  return withTradeRpcPriority(() => entryGuard({ client, concentration: m => traderBook.concentration(m, firehose.coins.get(m)?.launchedAtMs ?? null, smart?.relays()),
    priceSol: m => firehosePrice(m)?.priceQuotePerToken ?? null }, mint, stepSol));
};
// Curve entries (tui/curve-entry.ts): each coin is judged once it qualifies, through the same entry checks.
const curveTried = new Set<string>();
setInterval(() => {
  if (process.env.SLRD_CURVE !== "1") return; // off by default: entered near local tops with no wallet evidence
  const now = Date.now(), wallet = process.env.SLRD_AUTO_WALLET ?? readRegistry(root)[0]?.wallet, max = Number(process.env.SLRD_MAX_POSITIONS ?? 100);
  if (!wallet) return;
  for (const c of firehose.coins.values()) {
    if (curveTried.has(c.mint) || !curveSignal(c, now)) continue;
    curveTried.add(c.mint);
    const reg = readRegistry(root); if (reg.length >= max || reg.some(b => b.mint === c.mint)) continue;
    const cap = c.capUsd!, size = process.env.SLRD_CURVE_BUDGET ?? process.env.SLRD_AUTO_BUDGET ?? "0.05", r = curveRange(cap), name = c.symbol ?? c.mint.slice(0, 6);
    void (async () => {
      const veto = await guard(c.mint, Number(size) / r.steps).catch(e => `entry check failed: ${String(e).slice(0, 80)}`);
      if (veto) { log(`CURVE ${name} ${c.mint.slice(0, 6)}: skipped, ${veto}`); return; }
      const p = rangePath({ wallet, mint: c.mint }); writeFileSync(`${p}.tmp`, rangeFileBody("usd", String(r.buy), String(r.sell), r.steps).text); renameSync(`${p}.tmp`, p);
      addBot(root, { wallet, mint: c.mint, amount: size, mode: "target", auto: true });
      log(`CURVE ${name} ${c.mint}: cap $${Math.round(cap)}, ${c.traders?.size ?? 0} wallets, range ${r.buy}-${r.sell} x${r.steps}, ${size} SOL`);
    })();
  }
}, 5_000).unref?.();
const smart = startSmartEntry({ root, log, guard, paused: () => !!onlyMints(), holding: (t, m) => traderBook.holding(t, m), symbolFor: mint => firehose.coins.get(mint)?.symbol });
/** Quote token -> SOL for the firehose (coins quoted in XMR, DJT, PUMP, other pump coins, ...): Jupiter's price API,
 * which also returns decimals (WXMR has 12), batched 49 ids per request every 5s, cached 60s. No RPC: an on-chain
 * lookup per quote token flooded the only key and found no price for bridged tokens like WXMR. */
const quoteFh = new Map<string, { decimals: number | null; solPerUnit: number | null; at: number }>();
const quoteWanted = new Set<string>();
let quoteLogged = 0;
async function refreshQuotes() {
  const due = [...quoteWanted].filter(m => Date.now() - (quoteFh.get(m)?.at ?? 0) > 60_000);
  quoteWanted.clear();
  for (let i = 0; i < due.length; i += 48) {
    const ids = [...due.slice(i, i + 48), "So11111111111111111111111111111111111111112"];
    try {
      const j = await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids.join(",")}`, { signal: AbortSignal.timeout(8_000) })).json() as Record<string, { usdPrice?: number; decimals?: number } | undefined>;
      const sol = Number(j.So11111111111111111111111111111111111111112?.usdPrice);
      for (const m of due.slice(i, i + 48)) {
        const r = j[m], usd = Number(r?.usdPrice);
        quoteFh.set(m, { decimals: r?.decimals ?? null, solPerUnit: usd > 0 && sol > 0 ? usd / sol : null, at: Date.now() });
      }
    } catch {}
  }
  if (Date.now() - quoteLogged > 300_000 && quoteFh.size) {
    quoteLogged = Date.now();
    const known = [...quoteFh.values()].filter(q => q.solPerUnit && q.decimals != null).length;
    log(`firehose quotes: ${known}/${quoteFh.size} quote tokens priced via Jupiter`);
  }
}
setInterval(() => void refreshQuotes(), 5_000).unref?.();
function firehoseQuoteSol(mint: string) {
  const q = quoteFh.get(mint);
  if (!q || Date.now() - q.at > 60_000) quoteWanted.add(mint);
  return q && q.decimals != null && q.solPerUnit ? { decimals: q.decimals, solPerUnit: q.solPerUnit } : null;
}
const firehose = new Firehose({ quoteSol: firehoseQuoteSol, poolsPath: resolve(root, ".range-bots", "pool-mints.json"), solUsd: () => firehoseSolUsd, log, connection,
  onTrade: (mint, row, coin) => {
    traderBook.add(mint, row); smart?.onTrade(mint, row, coin);
    // pump.fun coins are priced from here: wake their bots and record the trade for the CLI.
    try { // running is declared further down: trades can arrive while the module is still starting
      let ours = false;
      for (const r of running.values()) if (r.entry.mint === mint) {
        ours = true; r.target?.wake();
        candles.add(mint, row.atMs, row.capUsd, row.sol);
        // No exit signal: the range decides every buy and sell; followable wallets only scale the size (below).
      }
      if (ours) tradeLog.addRow(mint, row);
    } catch {}
  },
  // pump.fun migrations come from the firehose now: no separate (often rate-limited) SQD stream, and the
  // cap is read from the new pool's own trades instead of the emptied curve.
  onMigration: m => { if (!onlyMints()) migrations?.migrate({ mint: m.mint, quoteMint: "So11111111111111111111111111111111111111112", pool: m.pool, destination: "pumpswap" }); } }); // isolated: entries are off, so no lookups
let migrations: Awaited<ReturnType<typeof startMigrationWatcher>> = null;
void firehose.start();
// Internal read-only endpoint for the bridge (wallet explorer): a coin's recent firehose trades.
// 127.0.0.1 only, same token as the bridge.
{
  const tokenFile = resolve(root, ".range-bots", "bridge-token");
  Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.SLRD_DAEMON_PORT ?? 5175), fetch(req) {
    let token = ""; try { token = readFileSync(tokenFile, "utf8").trim(); } catch {}
    if (!token || req.headers.get("x-slrd-token") !== token) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url), mint = url.searchParams.get("mint") ?? "";
    if (url.pathname === "/coin") {
      const c = firehose.coins.get(mint);
      return Response.json(c ? { ...c, recent: c.recent ?? [] } : null);
    }
    return new Response("not found", { status: 404 });
  } });
}
// 1h SOL volume of every coin we run a bot on (web Positions VOL 1H), in minute buckets saved to disk so a
// restart keeps the hour: minutes before this run started come from the file, later ones from the firehose.
const volPath = resolve(root, ".range-bots", "volumes.json");
let volSaved: Record<string, Array<[number, number]>> = {};
try { volSaved = (JSON.parse(readFileSync(volPath, "utf8")) as { buckets?: typeof volSaved }).buckets ?? {}; } catch {}
const volStartMin = Math.floor(Date.now() / 60_000);
setInterval(() => {
  const now = Date.now(), from = Math.floor(now / 60_000) - 59, sol: Record<string, number> = {}, buckets: typeof volSaved = {};
  let earliest = volStartMin;
  for (const b of readRegistry(root)) {
    const c = firehose.coins.get(b.mint); if (c) volume1h(c, now); // drops minutes older than an hour
    const merged = new Map<number, number>();
    for (const [m, v] of volSaved[b.mint] ?? []) if (m >= from && m < volStartMin) { merged.set(m, v); earliest = Math.min(earliest, m); }
    for (const [m, v] of c?.volMin ?? []) if (m >= volStartMin) merged.set(m, v);
    buckets[b.mint] = [...merged]; sol[b.mint] = [...merged.values()].reduce((x, y) => x + y, 0);
  }
  try { writeFileSync(`${volPath}.tmp`, JSON.stringify({ at: now, coveredMin: Math.min(60, Math.floor(now / 60_000) - Math.max(earliest, from)), sol, buckets })); renameSync(`${volPath}.tmp`, volPath); } catch {}
}, 10_000).unref?.();
// Discovery view (web/TUI): firehose health, hottest coins, recent migration decisions.
setInterval(() => {
  const now = Date.now(), ours = new Set(readRegistry(root).map(b => b.mint));
  const rejected = new Map(decisions.filter(d => d.decision === "dropped" || d.decision === "skipped" || d.decision === "failed").map(d => [d.mint, d.reason]));
  // Coins traded in the last 10 min (they drop off once activity stops): bonding curve and migrated listed
  // separately (60 each, most trades first) so the web and CLI can show them side by side.
  const live = [...firehose.coins.values()].filter(c => now - c.lastTradeMs < 10 * 60_000), watching = smart?.watching();
  const view = (c: (typeof live)[number]) => ({ mint: c.mint, symbol: c.symbol, capUsd: c.capUsd, ammCapUsd: c.ammCapUsd ?? null, trades: c.trades, lastTradeMs: c.lastTradeMs,
    migrated: c.migrated, launchedAtMs: c.launchedAtMs, traders: c.traders?.size ?? 0, volSol: c.volSol ?? 0, smart: watching?.get(c.mint)?.size ?? 0,
    ageMs: c.launchedAtMs ? now - c.launchedAtMs : null, status: ours.has(c.mint) ? "ours" : rejected.has(c.mint) ? "rejected" : c.migrated ? "migrated" : "curve", reason: rejected.get(c.mint) ?? null });
  const top = (xs: typeof live) => xs.sort((a, b) => b.trades - a.trades).slice(0, 60).map(view);
  const coins = [...top(live.filter(c => !c.migrated)), ...top(live.filter(c => c.migrated))];
  // The lists above rank by all-time trades, so a coin minutes old rarely gets on them: its own list, for whoever picks new pairs.
  const young = live.filter(c => !c.migrated && c.launchedAtMs && now - c.launchedAtMs <= 12 * 60_000).sort((a, b) => b.trades - a.trades).slice(0, 60).map(view);
  // Tickers for our bots and decided coins (web + TUI read symbols.json; metadata RPC often misses fresh coins).
  try {
    const path = resolve(root, ".range-bots", "symbols.json"); let sym: Record<string, string> = {};
    try { sym = JSON.parse(readFileSync(path, "utf8")); } catch {}
    let changed = false;
    for (const mint of [...ours, ...decisions.map(d => d.mint)]) { const t = firehose.coins.get(mint)?.symbol; if (t && !sym[mint]) { sym[mint] = t; changed = true; } }
    if (changed) { writeFileSync(path + ".tmp", JSON.stringify(sym, null, 1)); renameSync(path + ".tmp", path); }
  } catch {}
  const s = firehose.stats;
  const body = JSON.stringify({ at: now, firehose: { liveCoins: firehose.coins.size, trades: s.trades, perSec: s.trades / Math.max(1, (now - s.startedAt) / 1000), lagMs: s.lagMs, unknownPoolTrades: s.unknownPools },
    coins, young, decisions: decisions.slice(0, 100).map(d => { const c = firehose.coins.get(d.mint); return { ...d, symbol: c?.symbol ?? null, capUsd: c ? (c.ammTrades ? c.ammCapUsd : c.capUsd) ?? null : null }; }) });
  try { writeFileSync(resolve(root, ".range-bots", "discovery.json.tmp"), body); renameSync(resolve(root, ".range-bots", "discovery.json.tmp"), resolve(root, ".range-bots", "discovery.json")); } catch {}
}, 5_000).unref?.(); // live trades per coin for the TUI (.range-bots/trades/)
const warmer = client.warmBlockhash({ intervalMs: 30_000 }); // a blockhash is valid ~60s; a trade after 20s fetches its own
const { runRangeBot } = await import("./range-trade.ts");

// Bid-ask steps: one coin runs 1 engine ("main", steps = 1) or N slice engines (s0..sN-1),
// each owning 1/N of the amount and one rung of the range. A steps change waits until flat.
type Engine = { id: string; abort: AbortController; control: { resumeEntries?: () => boolean }; done: Promise<void> };
type Running = { entry: BotEntry; layout: number; engines: Map<string, Engine>; exit: "keep" | "sell" | null;
  startedAt: number; switching: boolean; sizeMult?: number; warnedLayout?: number; target?: TargetBot };
const targetStatusPath = (b: { wallet: string; mint: string }) => resolve(root, ".range-bots", `target-${b.wallet}-${b.mint}.json`);
function targetRange(b: BotEntry): TargetRange {
  const text = readFileSync(rangePath(b), "utf8"), bounds = rangeBounds(parseRangeFile(text));
  return { unit: bounds.unit, buy: Number(bounds.buy), sell: Number(bounds.sell), steps: parseRangeSteps(text) };
}
/** One-time backfill of each bot's net SOL flow from confirmed trades in the daemon log ("<wallet> <mint6>"). */
let flows: Map<string, number> | null = null;
function logFlows() {
  if (flows) return flows;
  flows = new Map();
  try {
    for (const m of readFileSync(daemonLog, "utf8").matchAll(/ (\S+) (\w{6}): (?:BUY|SELL|DEAD sell) confirmed CONFIRMED ([+-]?[\d.]+) SOL/g))
      flows.set(`${m[1]} ${m[2]}`, (flows.get(`${m[1]} ${m[2]}`) ?? 0) + Number(m[3]));
  } catch {}
  return flows;
}
/** Target mode: one balance-driven bot per coin instead of per-step engines. */
/** A bot can be added for any mint: register it with solard (venue, pool) the first time it is seen. */
const registering = new Map<string, Promise<void>>();
function ensureToken(mint: string): Promise<void> {
  // reconcile() can call this again while a registration is still running: share it.
  let p = registering.get(mint);
  // Registration is on the trade path (a bot cannot start without it): it jumps the RPC queue.
  if (!p) { p = withTradeRpcPriority(() => registerToken(mint)).finally(() => registering.delete(mint)); registering.set(mint, p); }
  return p;
}
async function registerToken(mint: string) {
  // Registered already? Ask solard's token registry (local DB), not the chain: a samplePrice check here cost ~8 RPC
  // calls per coin, ~640 at every start for 80 bots, a full minute of the only key.
  try { client.resolveToken(mint); return; }
  catch (error) { if (!String(error instanceof Error ? error.message : error).startsWith("Unknown token")) return; }
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { const t = await client.addToken(mint); log(`${mint.slice(0, 6)}: registered token ${t.symbol ?? t.name ?? ""} venue=${t.venueHint}`); return; }
    catch (error) { log(`${mint.slice(0, 6)}: token registration failed (attempt ${attempt}): ${error instanceof Error ? error.message : error}`); await Bun.sleep(5_000 * attempt); }
  }
}
const startingTargets = new Set<string>();
/** reconcile() runs on a timer and can call this again while an earlier start is still awaiting
 * (token registration, feed subscribe): a second start would run two bots on one coin. */
async function startTarget(entry: BotEntry): Promise<boolean> {
  const k = key(entry);
  if (startingTargets.has(k) || running.get(k)?.target) return false;
  startingTargets.add(k);
  try { return await startTargetOnce(entry); } finally { startingTargets.delete(k); }
}
async function startTargetOnce(entry: BotEntry): Promise<boolean> {
  const k = key(entry);
  // Engine state from an earlier mode: never switch over a transaction still in flight.
  if (existingIds(entry).some(id => readJson(statePathOf(entry, id))?.pending)) { log(`${k}: pending engine trade; target mode starts after it settles`); return false; }
  const archive = resolve(root, ".range-bots", "archive"); mkdirSync(archive, { recursive: true });
  for (const id of existingIds(entry)) renameSync(statePathOf(entry, id), resolve(archive, `bot-${entry.wallet}-${botId(entry, id)}-${Date.now()}.json`));
  targetRange(entry); // validate before starting
  await ensureToken(entry.mint);
  // Every bot's coin is in solard's per-coin trade stream: it fetches only our ~80 coins, so it stays fresh when the
  // SQD portal throttles us (measured: ~100 KB/s, 2.3 blocks/s, while the firehose needs all of pump.fun and falls
  // minutes behind). The firehose price is used first when it is fresh (see firehosePrice), this stream otherwise.
  await feed.add(entry.mint);
  chainPrices.add(entry.mint);
  holders.watch(entry.mint);
  const prevStatus = readJson(targetStatusPath(entry));
  seedPrice(entry.mint, prevStatus);
  const flowSol = prevStatus?.flowSol ?? logFlows().get(`${entry.wallet} ${entry.mint.slice(0, 6)}`) ?? 0;
  const supply = prevStatus?.supplyUi > 0 && prevStatus?.decimals != null ? { ui: prevStatus.supplyUi, decimals: prevStatus.decimals } : null;
  const bot = new TargetBot({ client, connection, wallet: entry.wallet, walletAddress: client.walletAddress(entry.wallet), mint: entry.mint,
    budgetSol: Number(entry.amount), range: () => targetRange(entry), samplePrice: () => {
      const p = firehosePrice(entry.mint) ?? chainPrices.price(entry.mint, 45_000); // stream first; rounds every 30s, 45s covers a slow round
      if (p) return Promise.resolve(p);
      // Coins the batched chain reader prices wait for its next round (a few seconds) instead of the per-coin RPC
      // path (~8 calls): that fallback from 80 bots at start-up got the only key rate-limited, the batch read too.
      if (chainPrices.handles(entry.mint)) return Promise.reject(new Error("waiting for the on-chain price round"));
      return feed.samplePrice(entry.mint);
    },
    statusPath: targetStatusPath(entry), buysPaused: entry.buysPaused,
    buyRoom: async sol => buyRoom({ freeSol: await walletFreeSol(entry.wallet, 5_000).catch(() => null), buySol: sol, addedAtMs: entry.addedAt, nowMs: Date.now(),
      floorSol: Number(process.env.SLRD_SOL_FLOOR ?? 0.1), newEntryMin: Number(process.env.SLRD_NEW_ENTRY_MIN ?? 30) }),
    balanceOf: (owner, mint) => walletBalances.balance(owner, mint), onTraded: () => { walletBalances.invalidate(client.walletAddress(entry.wallet)); freeSolByWallet.delete(entry.wallet); }, onPriceRejected: () => { feed.invalidate(entry.mint); seeds.delete(entry.mint); }, urgent: !!entry.smart,
    log: text => { log(text); write(botLogPath(entry), `annotation target ${text}`); },
    onDead: () => removeBot(root, entry.wallet, entry.mint), flowSol, supply }).start();
  running.set(k, { entry, layout: 0, engines: new Map(), exit: null, startedAt: Date.now(), switching: false, target: bot });
  log(`${k}: start TARGET mode, budget ${entry.amount} SOL${entry.buysPaused ? " (buys paused)" : ""}`);
  return true;
}
/** Sell the whole balance with retries (target-mode stop). */
/** Quote-token remainders. A pair quoted in another token (BAUD/PUMP) trades in two atomic legs, and the second
 * leg spends only the first leg's guaranteed minimum (so it never touches quote tokens you already hold): the
 * surplus over that minimum stays in the wallet on every buy and sell (BAUD left 310 PUMP, ~0.014 SOL, over 11
 * trades). Every 10 min, quote tokens of running bots' pairs that have no bot of their own are sold back to SOL
 * once worth more than SLRD_SWEEP_MIN_SOL (0.003). SLRD_SWEEP_QUOTES=0 turns it off. */
const SOL_MINT = "So11111111111111111111111111111111111111112";
let sweeping = false;
async function sweepQuotes() {
  if (sweeping || process.env.SLRD_SWEEP_QUOTES === "0") return; sweeping = true;
  try {
    const own = new Set([...running.values()].map(r => r.entry.mint)), todo = new Map<string, { wallet: string; quote: string; pairs: string[] }>();
    for (const r of running.values()) {
      let q: string | null = null; try { q = (client.resolveToken(r.entry.mint) as { quoteMint?: string | null }).quoteMint ?? null; } catch {}
      // USDC / USDT remainders are cash: not swept.
      if (!q || q === SOL_MINT || own.has(q) || q === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" || q === "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB") continue;
      const k = `${r.entry.wallet}:${q}`, t = todo.get(k) ?? todo.set(k, { wallet: r.entry.wallet, quote: q, pairs: [] }).get(k)!;
      t.pairs.push(r.entry.mint.slice(0, 6));
    }
    const min = Number(process.env.SLRD_SWEEP_MIN_SOL ?? 0.003);
    for (const t of todo.values()) {
      const bal = await walletBalances.balance(client.walletAddress(t.wallet), t.quote).catch(() => null);
      const px = firehoseQuoteSol(t.quote);
      if (!bal || bal.raw === 0n) continue;
      if (!px) { log(`quote sweep ${t.quote.slice(0, 6)}: ${bal.raw} raw held, no Jupiter price yet (next pass)`); continue; }
      const valueSol = Number(bal.raw) / 10 ** px.decimals * px.solPerUnit;
      if (valueSol < min) { log(`quote sweep ${t.quote.slice(0, 6)}: ~${valueSol.toFixed(5)} SOL held, under ${min}`); continue; }
      const r = await client.sell({ wallet: t.wallet, token: t.quote, amount: "all", slippageBps: 500 }).catch(e => ({ status: "failed", message: String(e) } as never as Awaited<ReturnType<typeof client.sell>>));
      log(`quote sweep ${t.wallet} ${t.quote.slice(0, 6)} (left by ${t.pairs.join(", ")}): ~${valueSol.toFixed(4)} SOL -> ${r.status}${(r as { message?: string }).message ? " " + String((r as { message?: string }).message).slice(0, 120) : ""}`);
      walletBalances.invalidate(client.walletAddress(t.wallet));
    }
  } finally { sweeping = false; }
}
setTimeout(() => void sweepQuotes(), 20_000).unref?.(); // first pass also asks Jupiter for the quote prices
setTimeout(() => void sweepQuotes(), 60_000).unref?.();
setInterval(() => void sweepQuotes(), 10 * 60_000).unref?.();

/** SOL the last sell-all brought in, per bot: the status file never sees it, so a closed bot's result is written here. */
const soldAll = new Map<string, number>();
async function sellAll(b: BotEntry): Promise<boolean> {
  for (let i = 1; i <= 8; i++) {
    const r = await client.sell({ wallet: b.wallet, token: b.mint, amount: "all", closeTokenAccount: true, slippageBps: 500 })
      .catch(error => ({ status: "failed", code: "ERROR", message: String(error), phase: "before-submission" } as never as Awaited<ReturnType<typeof client.sell>>));
    log(`${key(b)}: sell all attempt ${i}: ${r.status} ${r.code}${r.solPrincipalDeltaLamports != null ? ` +${(Number(r.solPrincipalDeltaLamports) / 1e9).toFixed(4)} SOL` : ""} ${r.signature ?? r.message.slice(0, 100)}`);
    if (r.status === "confirmed") { soldAll.set(key(b), Number(r.solPrincipalDeltaLamports ?? 0) / 1e9); return true; }
    if (r.status === "unresolved" || r.phase !== "before-submission") return false; // never risk a double sell
    if (/no .*balance|zero|nothing to sell|0 tokens/i.test(r.message)) return true;
    await Bun.sleep(4_000);
  }
  return false;
}
const running = new Map<string, Running>();
const key = (b: { wallet: string; mint: string }) => `${b.wallet}:${b.mint}`;
const rangePath = (b: { wallet: string; mint: string }) => resolve(root, "ranges", `${b.wallet}-${b.mint}.json`);
const engineIds = (steps: number) => steps === 1 ? ["main"] : Array.from({ length: steps }, (_, i) => `s${i}`);
const botId = (b: { mint: string }, id: string) => id === "main" ? b.mint : `${b.mint}.${id}`;
const statePathOf = (b: { wallet: string; mint: string }, id: string) => resolve(root, ".range-bots", `bot-${b.wallet}-${botId(b, id)}.json`);
const lockPathOf = (b: { wallet: string; mint: string }, id: string) => resolve(root, `bot-${b.wallet}-${botId(b, id)}.json.lock`);
const engineRangePath = (b: { wallet: string; mint: string }, id: string) => id === "main" ? rangePath(b) : resolve(root, "ranges", `${b.wallet}-${b.mint}.${id}.json`);
const failedAt = new Map<string, number>();
const readJson = (path: string) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
/** Engine ids that have a state file for this coin (any layout). */
function existingIds(b: BotEntry): string[] {
  const prefix = `bot-${b.wallet}-${b.mint}`;
  return readdirSync(resolve(root, ".range-bots")).filter(n => n.startsWith(prefix) && n.endsWith(".json"))
    .map(n => n.slice(prefix.length, -5)).filter(rest => rest === "" || /^\.s\d+$/.test(rest)).map(rest => rest === "" ? "main" : rest.slice(1));
}
const busy = (b: BotEntry, id: string) => { const s = readJson(statePathOf(b, id)); return !!(s?.position || s?.pending); };
function desiredSteps(b: BotEntry): number { try { return parseRangeSteps(readFileSync(rangePath(b), "utf8")); } catch { return 1; } }
/** Layout already holding tokens wins over a new steps value until it is flat. */
function heldLayout(b: BotEntry): number | null {
  const held = existingIds(b).filter(id => busy(b, id));
  if (!held.length) return null;
  if (held.includes("main")) return 1;
  return Math.max(...existingIds(b).filter(id => id !== "main").map(id => Number(id.slice(1)) + 1));
}
/** Write each rung's range file from the parent range (only when changed; engines hot-reload). */
function writeRungs(b: BotEntry, steps: number) {
  if (steps === 1) return;
  const parent = readFileSync(rangePath(b), "utf8");
  const bounds = rangeBounds(parseRangeFile(parent));
  for (const rung of stepRungs(bounds.buy, bounds.sell, steps, b.amount)) {
    const path = engineRangePath(b, rung.slice), text = rangeFileBody(bounds.unit, rung.buy, rung.sell).text;
    if (readFileSync(path, { flag: "a+" }).toString() !== text) { writeFileSync(`${path}.tmp`, text); renameSync(`${path}.tmp`, path); }
  }
}

function pidAlive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
/** A lock owned by a dead process is stale; one owned by a live terminal bot means "not ours". */
function claimLock(b: BotEntry, id: string): boolean {
  const path = lockPathOf(b, id);
  if (!existsSync(path)) return true;
  const pid = Number(readFileSync(path, "utf8").trim());
  // Our own pid: called only when this engine is not running here, so the lock is a leftover.
  if (pid === process.pid) { rmSync(path, { force: true }); return true; }
  if (Number.isInteger(pid) && pidAlive(pid)) return false;
  mkdirSync(resolve(root, ".range-bots", "recovery"), { recursive: true });
  renameSync(path, resolve(root, ".range-bots", "recovery", `bot-${b.wallet}-${botId(b, id).slice(0, 8)}-${pid}-${Date.now()}.lock`));
  return true;
}

function startEngine(r: Running, id: string) {
  const b = r.entry, k = key(b);
  if (!claimLock(b, id)) { log(`${k}/${id}: locked by another live process; skipped`); return; }
  const amount = id === "main" ? b.amount : splitAmount(b.amount, r.layout);
  const abort = new AbortController(), control: Engine["control"] = {};
  scopeLog.set(`range-${b.mint.slice(0, 8)}${id === "main" ? "" : `.${id}`}`, botLogPath(b));
  const engine: Engine = { id, abort, control, done: Promise.resolve() };
  r.engines.set(id, engine);
  engine.done = runRangeBot(["--mint", b.mint, "--wallet", b.wallet, "--amount", amount, "--interval", "1500",
    "--hold-ms", "0", "--range-file", engineRangePath(b, id), "--rpc-url", rpcUrl!, ...(id === "main" ? [] : ["--slice", id])],
    // Pre-signed orders refresh every 6s (not 2s): with many engines that refresh was most of the RPC load.
    { signal: abort.signal, control, client, sharedBlockhashWarmer: true, preparationIntervalMs: 6_000, samplePrice: () => feed.samplePrice(b.mint) })
    .catch(error => { log(`${k}/${id}: engine error ${error instanceof Error ? error.message : error}`); failedAt.set(k, Date.now()); })
    .finally(() => { r.engines.delete(id); });
}

async function start(entry: BotEntry) {
  const k = key(entry);
  if (running.has(k)) return;
  if (!existsSync(rangePath(entry))) { log(`${k}: no range file; skipped`); return; }
  if (entry.mode === "target") { await startTarget(entry); return; }
  const layout = heldLayout(entry) ?? desiredSteps(entry);
  writeRungs(entry, layout);
  await feed.add(entry.mint);
  const r: Running = { entry, layout, engines: new Map(), exit: null, startedAt: Date.now(), switching: false };
  running.set(k, r);
  log(`${k}: start ${layout === 1 ? "" : `${layout} steps, `}${entry.amount} SOL`);
  for (const id of engineIds(layout)) startEngine(r, id);
}

async function stopAll(r: Running) {
  for (const e of r.engines.values()) e.abort.abort();
  await Promise.all([...r.engines.values()].map(e => e.done).concat(r.target ? [r.target.stop()] : []));
}
async function finish(r: Running) {
  const b = r.entry, k = key(b);
  await stopAll(r);
  if (r.target) {
    if (r.exit === "sell" && !(await sellAll(b))) {
      log(`${k}: SELL DID NOT HAPPEN; target bot keeps running. Press x x again or sell manually.`);
      r.exit = null; running.delete(k); await startTarget(b); return;
    }
    running.delete(k); removeBot(root, b.wallet, b.mint); await feed.remove(b.mint);
    if (r.exit === "sell") try { appendFileSync(resolve(root, ".range-bots", "closed-pnl.jsonl"), JSON.stringify({ at: Date.now(), wallet: b.wallet, mint: b.mint, pnlSol: (r.target.status.flowSol ?? 0) + (soldAll.get(k) ?? 0) }) + "\n"); } catch {}
    log(`${k}: stopped (${r.exit === "sell" ? "sold all + closed" : "position kept"})`);
    return;
  }
  if (r.exit === "sell") {
    let outcome: Awaited<ReturnType<typeof exitPosition>> | "error" = "error";
    // Keep trying: a stop+sell must not give up after a short RPC outage.
    for (let round = 1; round <= 5; round++) {
      outcome = await exitPosition({ client, wallet: b.wallet, mint: b.mint, statePath: existingIds(b).map(id => statePathOf(b, id)),
        say: text => { log(`${k}: ${text}`); write(botLogPath(b), `annotation exit ${text}`); }, log: text => write(botLogPath(b), text) })
        .catch(error => { log(`${k}: exit sell error ${error}`); return "error" as const; });
      if (outcome !== "failed" && outcome !== "error") break;
      await Bun.sleep(5_000);
    }
    if (outcome !== "sold" && outcome !== "flat") {
      // NOT sold: keep managing the position instead of dropping it.
      log(`${k}: SELL DID NOT HAPPEN (${outcome}); bot keeps running with the position. Press x x again or sell manually.`);
      r.exit = null;
      for (const id of engineIds(r.layout)) startEngine(r, id);
      return;
    }
  }
  running.delete(k);
  removeBot(root, b.wallet, b.mint); await feed.remove(b.mint);
  log(`${k}: stopped (${r.exit === "sell" ? "sold+closed" : "position kept"})`);
}

/** Steps changed and everything is flat: retire the old engines and start the new layout. */
async function maybeSwitchLayout(r: Running) {
  const b = r.entry, want = desiredSteps(b);
  if (want === r.layout || r.switching || r.exit) return;
  const states = existingIds(b).map(id => ({ id, s: readJson(statePathOf(b, id)) }));
  // 1 step holding -> N steps: split the position evenly so each step sells at its own level.
  const main = states.find(x => x.id === "main")?.s;
  const splitHolding = r.layout === 1 && want > 1 && main?.position && !states.some(x => x.s?.pending)
    && states.every(x => x.id === "main" || !x.s?.position);
  if (!splitHolding && states.some(x => x.s?.position || x.s?.pending)) {
    if (r.warnedLayout !== want) { r.warnedLayout = want; log(`${key(b)}: steps ${r.layout} → ${want} waits until all steps are flat`); }
    return;
  }
  r.switching = true;
  log(`${key(b)}: switching to ${want} step${want === 1 ? "" : "s"}${splitHolding ? " (splitting the held position across steps)" : ""}`);
  await stopAll(r);
  // Re-read after the engines stopped: a trade may have settled while stopping.
  const held = splitHolding ? readJson(statePathOf(b, "main")) : null;
  if (splitHolding && (!held?.position || held.pending)) { r.switching = false; log(`${key(b)}: position changed while stopping; switch retried later`); for (const id of engineIds(r.layout)) startEngine(r, id); return; }
  const archive = resolve(root, ".range-bots", "archive");
  mkdirSync(archive, { recursive: true });
  // A buy pause (external exit, operator exit) carries over to the new steps: switching must not start buying.
  const pause = states.map(x => x.s?.entryPause).find(Boolean);
  for (const id of existingIds(b)) renameSync(statePathOf(b, id), resolve(archive, `bot-${b.wallet}-${botId(b, id)}-${Date.now()}.json`));
  const ids = engineIds(want);
  const amount = held ? BigInt(held.position.amountRaw) : 0n, cost = held ? BigInt(held.position.costLamports) : 0n;
  ids.forEach((id, i) => {
    const last = i === ids.length - 1, n = BigInt(ids.length);
    const position = held ? { amountRaw: (last ? amount - amount / n * (n - 1n) : amount / n).toString(),
      costLamports: (last ? cost - cost / n * (n - 1n) : cost / n).toString() } : null;
    if (!position && !pause) return;
    writeFileSync(statePathOf(b, id), JSON.stringify({ phase: position ? "sell" : "buy", position, pending: null, prices: [], sequence: 0,
      ...(pause ? { entryPause: pause } : {}) }));
  });
  r.layout = want; r.switching = false; r.warnedLayout = undefined;
  if (held) log(`${key(b)}: split ${held.position.amountRaw} raw across ${want} steps; each sells at its own level`);
  if (pause) log(`${key(b)}: new buys stay paused (${pause.reason}); press r to resume`);
  writeRungs(b, want);
  for (const id of engineIds(want)) startEngine(r, id);
}

function pollCommands() {
  for (const r of running.values()) {
    const path = rangePath(r.entry).replace(/\.json$/, ".cmd");
    if (!existsSync(path)) continue;
    let cmd = "";
    try { cmd = readFileSync(path, "utf8").trim().toLowerCase(); rmSync(path, { force: true }); } catch { continue; }
    const k = key(r.entry);
    if ((cmd === "resume" || cmd === "pause") && r.target) {
      r.target.setBuysPaused(cmd === "pause"); updateBot(root, r.entry.wallet, r.entry.mint, { buysPaused: cmd === "pause" });
      log(`${k}: buys ${cmd === "pause" ? "paused (sells continue)" : "resumed"}`);
    }
    else if (cmd === "resume") { const n = [...r.engines.values()].filter(e => e.control.resumeEntries?.()).length; log(`${k}: ${n ? `new buys resumed (${n} step${n === 1 ? "" : "s"})` : "resume: not paused"}`); }
    else if ((cmd === "stop" || cmd === "kill") && !r.exit) { r.exit = cmd === "stop" ? "sell" : "keep"; log(`${k}: ${cmd === "stop" ? "stop + sell" : "stop (keep position)"} requested`); void finish(r); }
  }
}

let reconciling = false;
async function reconcile() {
  if (reconciling) return; // one pass at a time
  reconciling = true;
  try { await reconcileOnce(); } finally { reconciling = false; }
}
async function reconcileOnce() {
  const wanted = isolated(readRegistry(root));
  for (const entry of wanted) {
    const k = key(entry), r = running.get(k);
    if (r) {
      if (r.exit || r.switching) continue;
      if (r.target) { // target mode reads its range every tick; follow pause changes from the registry
        // Size = your registry size x the smart-wallet multiplier (sizeBySmartWallets): you set the base, they scale it.
        const want = Math.round(Number(entry.amount) * (r.sizeMult ?? 1) * 1e6) / 1e6;
        if (Number(entry.amount) > 0 && Math.abs(want - r.target.status.budgetSol) > 1e-9) { log(`${k}: budget ${r.target.status.budgetSol} -> ${want} SOL (${entry.amount} x${r.sizeMult ?? 1})`); r.target.setBudget(want); r.entry.amount = entry.amount; }
        if (!!entry.buysPaused !== r.target.status.buysPaused) { r.target.setBuysPaused(!!entry.buysPaused); log(`${k}: buys ${entry.buysPaused ? "paused" : "resumed"} (registry)`); }
        r.entry = entry; continue;
      }
      if (entry.mode === "target") {
        // Switched to target mode: stop the step engines (positions stay in the wallet) and hand over.
        if (existingIds(entry).some(id => readJson(statePathOf(entry, id))?.pending)) continue;
        r.switching = true; log(`${k}: switching to TARGET mode`);
        await stopAll(r); running.delete(k);
        await startTarget(entry).catch(error => log(`${k}: target start failed ${error}`));
        continue;
      }
      try { if (r.layout > 1) writeRungs(entry, r.layout); } catch (error) { log(`${k}: range not applied: ${error instanceof Error ? error.message : error}`); }
      await maybeSwitchLayout(r).catch(error => { r.switching = false; log(`${k}: steps switch failed ${error}`); });
      // Restart engines that died (crash), after a pause.
      if (!r.switching && Date.now() - (failedAt.get(k) ?? 0) > 30_000)
        for (const id of engineIds(r.layout)) if (!r.engines.has(id)) { log(`${k}/${id}: restarting engine`); startEngine(r, id); }
      continue;
    }
    if (Date.now() - (failedAt.get(k) ?? 0) < 30_000) continue;
    // Start in the background: one slow token registration must not hold up every other new bot.
    void start(entry).catch(error => { log(`${k}: start failed ${error}`); failedAt.set(k, Date.now()); });
  }
  // Removed from the registry without a stop command: stop, keep the position. Re-read the registry:
  // the loop above can take a minute (token registration) and bots added meanwhile are not in `wanted`.
  const current = isolated(readRegistry(root));
  for (const r of running.values())
    if (!current.some(b => key(b) === key(r.entry)) && !r.exit) { r.exit = "keep"; log(`${key(r.entry)}: removed from registry; stopping (position kept)`); void finish(r); }
}

function writeStatus() {
  const status = { pid: process.pid, at: Date.now(), feed: { status: feed.status, lastBlockMs: feed.lastBlockMs, lagMs: feed.lastBlockMs ? Date.now() - feed.lastBlockMs : null },
    bots: [...running.values()].map(r => ({ wallet: r.entry.wallet, mint: r.entry.mint, startedAt: r.startedAt, stopping: r.exit, steps: r.layout, engines: [...r.engines.keys()], mode: r.target ? "target" : "engine" })), prices: feed.stats() };
  try { const p = resolve(root, ".range-bots", "daemon-status.json"); writeFileSync(`${p}.tmp`, JSON.stringify(status)); renameSync(`${p}.tmp`, p); } catch {}
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return; stopping = true;
  log(`${signal}: stopping all bots (positions kept)`);
  await Promise.race([Promise.all([...running.values()].map(r => stopAll(r))), Bun.sleep(15_000)]);
  warmer.stop(); await feed.close();
  try { if (Number(readFileSync(daemonPidPath(root), "utf8")) === process.pid) rmSync(daemonPidPath(root)); } catch {}
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

log(`slrd-bots started (pid ${process.pid}); ${readRegistry(root).length} bots in registry`);
void startMigrationWatcher({ root, client, connection, log, stream: false, guard, symbolFor: mint => firehose.coins.get(mint)?.symbol, capFor: mint => firehose.coins.get(mint)?.ammTrades ? firehose.coins.get(mint)?.ammCapUsd : null,
  activityFor: mint => { const c = firehose.coins.get(mint); return c ? { traders: c.traders?.size ?? 0, volSol: c.volSol ?? 0, fromLaunch: c.launchedAtMs != null } : null; } }).then(w => { migrations = w; }).catch(error => log(`migration watcher failed: ${error}`));
await reconcile();
setInterval(() => { if (!stopping) { pollCommands(); void reconcile(); writeStatus(); } }, 2_000);
