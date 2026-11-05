/** slrd-bridge: the browser terminal's view of the local slrd-bots daemon. Optional: the page also runs
 * without it (browser-only). Listens on 127.0.0.1 only; every /api call needs the token from
 * .range-bots/bridge-token (the URL printed at start carries it once, then the page keeps it).
 * It reads the same files as the TUI and controls bots through the same files the daemon follows:
 * status (.range-bots/target-*.json), trades (.range-bots/trades/), registry, ranges/*.json, ranges/*.cmd.
 *   bun slrd-bridge.ts            -> http://127.0.0.1:5174/#token=...   (serves web/dist too) */
import { coinIndex, scoreWallet, type StatRow, type WalletScore } from "./tui/wallet-scores.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { earlyBoughtPct } from "./tui/bundles.ts";
import { fillsFromLog } from "./tui/fill-log.ts";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { activateRpc } from "./packages/cli/src/rpc-management.ts";
import { SolardConnection } from "./packages/core/src/chain/connection.ts";
import { getSolUsdPrice } from "./packages/core/src/market/launch-trades.ts";
import { rangeFileBody } from "./packages/core/src/runtime/range-commands.ts";
import { createSolard } from "./packages/sdk/src/index";
import { addBot, daemonPid, readRegistry, removeBot, updateBot } from "./tui/bot-registry.ts";
import { positionValueSol, scanBots } from "./tui/screen.ts";
import { readTrades } from "./tui/trade-log.ts";
import { openDatabase } from "./packages/core/src/db/database.ts";

const root = import.meta.dir;
process.chdir(root);
const toml = resolve(root, ".config.toml");
if (existsSync(toml)) {
  const slrd = (Bun.TOML.parse(readFileSync(toml, "utf8")) as Record<string, Record<string, unknown>>).slrd ?? {};
  for (const [k, v] of Object.entries(slrd)) if (process.env[`SLRD_${k}`.toUpperCase()] === undefined && v != null && typeof v !== "object") process.env[`SLRD_${k}`.toUpperCase()] = String(v);
}
activateRpc(new Map());
process.env.SLRD_RPC_VERIFY_MAINNET = "0";
const connection = new SolardConnection(process.env.RPC_ENDPOINT!).get();
const slrd = createSolard({ transactionVersion: 1, rpcUrl: process.env.RPC_ENDPOINT! } as Parameters<typeof createSolard>[0]);

const tokenPath = join(root, ".range-bots", "bridge-token");
mkdirSync(join(root, ".range-bots"), { recursive: true });
const token = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : randomBytes(24).toString("hex");
writeFileSync(tokenPath, token);

// Wallets: names + addresses from the solard DB; SOL balance only for wallets that have bots, every 2 min.
type Wallet = { name: string; address: string; sol: number | null };
const wallets: Wallet[] = (() => { try { return slrd.listWallets().map(w => ({ name: w.name, address: w.address, sol: null })); } catch { return []; } })();
async function refreshBalances() {
  const used = new Set(readRegistry(root).map(b => b.wallet));
  for (const w of wallets) if (used.has(w.name)) {
    try { w.sol = (await connection.getBalance(new PublicKey(w.address), "confirmed")) / 1e9; } catch {}
  }
}
void refreshBalances(); setInterval(refreshBalances, 120_000);
let solUsd: number | null = null;
const refreshSol = async () => { try { solUsd = (await getSolUsdPrice()).price; } catch {} };
void refreshSol(); setInterval(refreshSol, 60_000);

const symbols = () => { try { return JSON.parse(readFileSync(join(root, ".range-bots", "symbols.json"), "utf8")) as Record<string, string>; } catch { return {}; } };
const rangePath = (w: string, m: string) => join(root, "ranges", `${w}-${m}.json`);
const valid = (s: unknown) => typeof s === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(s);
const validMint = (s: unknown) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

// ---------- wallet explorer ----------
// Scores for every wallet come from a worker (the whole traderStats table is millions of rows, ~40s: reading it
// here froze every page request). One wallet's page reads only its own rows and its coins through the indexes.
const db = openDatabase(process.env.SLRD_DB_PATH);
let scores: WalletScore[] = [], scoreOf = new Map<string, WalletScore>(), scoresAt = 0, scoring = false;
function refreshScores() {
  if (scoring) return; scoring = true;
  const w = new Worker(new URL("./tui/wallet-scores-worker.ts", import.meta.url).href);
  const done = () => { scoring = false; w.terminate(); };
  w.onmessage = (ev: MessageEvent<{ ok: boolean; scores?: WalletScore[]; error?: string }>) => {
    if (ev.data.ok && ev.data.scores) { scores = ev.data.scores; scoreOf = new Map(scores.map(x => [x.trader, x])); scoresAt = Date.now(); }
    else console.error("wallet scores failed:", ev.data.error);
    done();
  };
  w.onerror = e => { console.error("wallet scores worker:", e.message); done(); };
  w.postMessage(null);
}
refreshScores(); setInterval(refreshScores, 60 * 60_000); // reads the whole table, many GB: not often
function walletsApi(url: URL) {
  const minCoins = Number(url.searchParams.get("minCoins") ?? 3), sort = url.searchParams.get("sort") ?? "pnl";
  const list = scores.filter(s => s.coins >= minCoins);
  const key: Record<string, (s: WalletScore) => number> = { pnl: s => s.pnlSol, winrate: s => s.wins / s.coins, early: s => -(s.avgRankPct || 999), coins: s => s.coins, trades: s => s.trades };
  list.sort((a, b) => (key[sort] ?? key.pnl!)(b) - (key[sort] ?? key.pnl!)(a));
  return { at: scoresAt, wallets: scores.length, rows: list.slice(0, 300) };
}
function walletApi(addr: string) {
  const sym = symbols(), own = db.traderStats.select().where({ trader: addr }).all() as StatRow[];
  // Its coins' rows (most recent 150 coins): entry rank, buyer counts, marks and co-traders come from these.
  const mints = [...new Set(own.sort((a, b) => b.lastAtMs - a.lastAtMs).map(r => r.mint))].slice(0, 150);
  const coinRows = mints.flatMap(m => db.traderStats.select().where({ mint: m }).all() as StatRow[]);
  const ix = coinIndex(coinRows);
  const rows = own.filter(r => mints.includes(r.mint)).map(r => {
    const held = Math.max(0, r.tokensBought - r.tokensSold), px = ix.mark.get(r.mint) ?? r.lastPriceSol ?? 0;
    return { ...r, symbol: sym[r.mint] ?? null, heldTokens: held, openSol: held * px, pnlSol: r.solOut - r.solIn + held * px,
      rank: ix.rank.get(`${addr}:${r.mint}`) ?? null, buyers: ix.buyers.get(r.mint) ?? 0 };
  });
  // Co-traders: wallets sharing the most coins with this one (bundles / same operator show up here).
  const shared = new Map<string, number>();
  for (const r of coinRows) if (r.trader !== addr) shared.set(r.trader, (shared.get(r.trader) ?? 0) + 1);
  const co = [...shared].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([trader, n]) => ({ trader, shared: n, score: scoreOf.get(trader) ?? null }));
  return { wallet: addr, score: scoreOf.get(addr) ?? scoreWallet(addr, own, ix), coins: rows, coTraders: co };
}
/** One coin, all its wallets: net position from every trade the firehose has seen (traderStats, at most 15s
 * behind), live trades from the daemon memory, and each wallet's change over the last 5 min (growing / shrinking). */
let smartCache: { at: number; map: Map<string, { realizedSol: number; winRate: number; coins: number }> } | null = null;
function smartWallets() {
  if (smartCache && Date.now() - smartCache.at < 60_000) return smartCache.map;
  let list: Array<{ trader: string; realizedSol: number; winRate: number; coins: number }> = [];
  try { list = JSON.parse(readFileSync(join(root, ".range-bots", "smart-wallets.json"), "utf8")); } catch {}
  smartCache = { at: Date.now(), map: new Map(list.map(w => [w.trader, w])) };
  return smartCache.map;
}
type LiveTrade = { signature: string; atMs: number; side: string; sol: number | null; tokens: number | null; capUsd: number | null; trader: string | null; creator: string | null };
/** Lifetime wallet profile (scores worker, every 5 min); null until the first build. */
const profileOf = (trader: string) => scoreOf.get(trader) ?? null;
/** Ask the daemon to keep exact holders for a coin opened on a page (it watches what was opened in the last 30 min). */
function requestHolders(mint: string) {
  const p = join(root, ".range-bots", "holders-watch.json");
  let list: Array<{ mint: string; at: number }> = [];
  try { list = JSON.parse(readFileSync(p, "utf8")); } catch {}
  list = [{ mint, at: Date.now() }, ...list.filter(x => x.mint !== mint && Date.now() - x.at < 30 * 60_000)].slice(0, 30);
  try { writeFileSync(p + ".tmp", JSON.stringify(list)); renameSync(p + ".tmp", p); } catch {}
}
type HolderFile = { ready: boolean; holders: Array<{ owner: string; amount: number; pct: number; from: string | null }>; clusters: Array<{ source: string; members: number; pct: number }>;
  transfers: Array<{ atMs: number; signature: string | null; from: string[]; to: string[]; amount: number }>; transferCount: number };
/** Saved 1-minute candles and our confirmed fills: the coin's whole tracked life for the chart. No downloads. */
let candleFile: { mtimeMs: number; all: Record<string, unknown[]> } | null = null;
function coinHistory(mint: string) {
  let candles: unknown[] = [];
  try {
    const path = join(root, ".range-bots", "candles.json"), mtimeMs = statSync(path).mtimeMs;
    if (candleFile?.mtimeMs !== mtimeMs) candleFile = { mtimeMs, all: JSON.parse(readFileSync(path, "utf8")) };
    candles = candleFile.all[mint] ?? [];
  } catch {}
  const fills = readdirSync(join(root, ".range-bots")).filter(f => f.startsWith("term-") && f.endsWith(`-${mint}.log`)).flatMap(f => {
    try { return fillsFromLog(readFileSync(join(root, ".range-bots", f), "utf8")); } catch { return []; }
  });
  return { candles, fills };
}
async function coinWalletsApi(mint: string, watch = true) {
  if (watch) requestHolders(mint); // an embedded page looking around must not start a history download per coin
  let exact: HolderFile | null = null;
  try { exact = JSON.parse(readFileSync(join(root, ".range-bots", "holders", `${mint}.json`), "utf8")) as HolderFile; } catch {}
  const { coin, symbol } = await coinApi(mint);
  const recent: LiveTrade[] = coin?.recent ?? [];
  let relaySet = new Set<string>();
  try { relaySet = new Set(JSON.parse(readFileSync(join(root, ".range-bots", "relay-wallets.json"), "utf8")) as string[]); } catch {}
  // Relay/router accounts (they hand the tokens to their users; see tui/smart-entry.ts relayWallets) are not holders.
  const rows = (db.traderStats.select().where({ mint }).all() as StatRow[]).filter(r => !relaySet.has(r.trader));
  const smartMap = smartWallets(), mine = new Map(wallets.map(w => [w.address, w.name]));
  const creator = recent.find(t => t.creator)?.creator ?? null;
  const last = recent[recent.length - 1], price = last?.sol && last.tokens ? last.sol / last.tokens : null;
  const supply = 1e9, now = Date.now(), d5 = new Map<string, { tokens: number; sol: number; last: string; at: number }>();
  for (const t of recent) {
    if (!t.trader || now - t.atMs > 5 * 60_000) continue;
    const x = d5.get(t.trader) ?? { tokens: 0, sol: 0, last: t.side, at: t.atMs };
    const sign = t.side === "buy" ? 1 : -1; x.tokens += sign * (t.tokens ?? 0); x.sol += sign * (t.sol ?? 0); x.last = t.side; x.at = t.atMs;
    d5.set(t.trader, x);
  }
  const list: Array<Record<string, unknown> & { trader: string; held: number; lastAtMs: number }> = rows.map(r => {
    const held = Math.max(0, r.tokensBought - r.tokensSold), s = smartMap.get(r.trader) ?? null;
    return { trader: r.trader, held, pct: held / supply * 100, buys: r.buys, sells: r.sells, solIn: r.solIn, solOut: r.solOut,
      pnlSol: r.solOut - r.solIn + (price ? held * price : 0), firstAtMs: r.firstAtMs, lastAtMs: r.lastAtMs, entryCapUsd: r.entryCapUsd ?? null,
      delta5: d5.get(r.trader) ?? null, smart: s, ours: mine.get(r.trader) ?? null, dev: r.trader === creator,
      // Lifetime profile across every coin we recorded (leaderboard data): shown as SCORE and on hover.
      profile: (() => { const p = profileOf(r.trader); return p ? { coins: p.coins, wins: p.wins, trades: p.trades, volumeSol: p.solIn * 2 + p.realizedSol, pnlSol: p.pnlSol, realizedSol: p.realizedSol, medEntryCap: p.medEntryCap, medExitCap: p.medExitCap, medMultiple: p.medMultiple, medHoldMin: p.medHoldMin, avgRankPct: p.avgRankPct } : null; })() };
  });
  // Exact holdings from token balances (transfers included) replace the trade-derived estimate when available.
  if (exact?.ready) {
    const byOwner = new Map(exact.holders.map(h => [h.owner, h]));
    for (const w of list) { const h = byOwner.get(w.trader); (w as { held: number }).held = h ? h.amount : 0; (w as { pct: number }).pct = h ? h.pct : 0; (w as { from?: string | null }).from = h?.from ?? null; byOwner.delete(w.trader); }
    // Holders that never traded: they got their tokens by transfer (bundle wallets, relays' users).
    for (const h of byOwner.values()) if (!relaySet.has(h.owner)) list.push({ trader: h.owner, held: h.amount, pct: h.pct, buys: 0, sells: 0, solIn: 0, solOut: 0, pnlSol: 0, firstAtMs: 0, lastAtMs: 0,
      entryCapUsd: null, delta5: null, smart: smartMap.get(h.owner) ?? null, ours: mine.get(h.owner) ?? null, dev: h.owner === creator, profile: null, from: h.from, viaTransfer: true } as never);
  }
  list.sort((a, b) => b.held - a.held || b.lastAtMs - a.lastAtMs);
  return { ...coinHistory(mint), earlyBoughtPct: earlyBoughtPct(rows), mint, symbol, exact: exact?.ready ?? false, clusters: exact?.clusters ?? [], transfers: exact?.transfers?.slice(0, 100) ?? [], transferCount: exact?.transferCount ?? 0, capUsd: coin ? (coin.ammTrades ? coin.ammCapUsd : coin.capUsd) ?? null : null, migrated: coin?.migrated ?? null,
    launchedAtMs: coin?.launchedAtMs ?? null, trades: coin?.trades ?? rows.reduce((a, r) => a + r.buys + r.sells, 0), creator, priceSol: price,
    wallets: list.slice(0, 500), walletCount: list.length, holders: list.filter(w => w.held > 0).length,
    recent: recent.slice(-200).reverse().map(t => ({ ...t, smart: !!(t.trader && smartMap.has(t.trader)), ours: t.trader ? mine.get(t.trader) ?? null : null })) };
}
async function coinApi(mint: string) {
  const r = await fetch(`http://127.0.0.1:${process.env.SLRD_DAEMON_PORT ?? 5175}/coin?mint=${mint}`, { headers: { "x-slrd-token": token } }).catch(() => null);
  const coin = r?.ok ? await r.json() : null;
  return { coin, symbol: symbols()[mint] ?? coin?.symbol ?? null };
}

const onlyPath = () => join(root, ".range-bots", "only.json");
function onlyList(): string[] | null { try { const l = JSON.parse(readFileSync(onlyPath(), "utf8")) as string[]; return l.length ? l : null; } catch { return null; } }
function state() {
  const sym = symbols(), locked = new Map(readRegistry(root).map(b => [`${b.wallet}:${b.mint}`, b.rangeLocked]));
  const bots = scanBots(root).map(b => {
    const value = positionValueSol(b);
    return { ...b, rangeLocked: !!locked.get(`${b.wallet}:${b.mint}`), symbol: sym[b.mint] ?? null, valueSol: value, pnlSol: value != null && b.costSol != null ? value - b.costSol : null };
  });
  // Registry bots that are not running, with their last known numbers: the extension shows them with an Enable button.
  const running = new Set(bots.map(b => `${b.wallet}:${b.mint}`));
  const inactive = readRegistry(root).filter(b => b.mode === "target" && !running.has(`${b.wallet}:${b.mint}`)).flatMap(b => {
    try {
      const t = JSON.parse(readFileSync(join(root, ".range-bots", `target-${b.wallet}-${b.mint}.json`), "utf8"));
      return [{ wallet: b.wallet, mint: b.mint, mode: "target", inactive: true, symbol: sym[b.mint] ?? null, range: t.range, capUsd: t.capUsd, priceSol: t.priceSol, steps: t.steps, holdingSteps: t.held, target: 0,
        budgetSol: t.budgetSol, valueSol: Number(t.balanceRaw ?? 0) / 10 ** (t.decimals ?? 6) * (t.priceSol ?? 0), nextBuy: null, nextSell: null, paused: !!b.buysPaused, rangeLocked: !!b.rangeLocked }];
    } catch { return []; }
  });
  return { wallets, bots, inactive, only: onlyList(), solUsd, daemon: { pid: daemonPid(root) }, registry: readRegistry(root).length, at: Date.now() };
}

async function act(body: Record<string, unknown>) {
  const { action, wallet, mint } = body;
  if (!valid(wallet) || !validMint(mint)) throw new Error("wallet and mint required");
  const w = wallet as string, m = mint as string;
  const cmd = (c: string) => writeFileSync(rangePath(w, m).replace(/\.json$/, ".cmd"), c);
  switch (action) {
    case "enable": case "disable": {
      const list = onlyList();
      if (!list) { if (action === "enable") return "already running"; throw new Error("not isolated: every bot is running"); }
      writeFileSync(onlyPath(), JSON.stringify(action === "enable" ? [...new Set([...list, m])] : list.filter(x => x !== m)));
      return action === "enable" ? "enabled, starting" : "disabled";
    }
    case "lock": updateBot(root, w, m, { rangeLocked: true }); return "range locked: the daemon will not move it";
    case "unlock": updateBot(root, w, m, { rangeLocked: false }); return "range unlocked";
    case "pause": cmd("pause"); return "buys paused";
    case "resume": cmd("resume"); return "buys resumed";
    case "stop": cmd("stop"); return "selling all, then stopping";
    case "remove": removeBot(root, w, m); return "bot removed (position kept)";
    case "relaunch": {
      const prev = readRegistry(root).find(b => b.wallet === w && b.mint === m);
      if (prev) return "already running";
      if (!existsSync(rangePath(w, m))) throw new Error("no range file for this bot");
      addBot(root, { wallet: w, mint: m, amount: String(body.budget ?? "0.05"), mode: "target" }); return "relaunched";
    }
    case "budget": {
      const budget = Number(body.budget);
      if (!(budget > 0 && budget <= 5)) throw new Error("size must be between 0 and 5 SOL");
      if (!readRegistry(root).some(b => b.wallet === w && b.mint === m)) throw new Error("bot is not running");
      updateBot(root, w, m, { amount: String(budget) }); return `size set to ${budget} SOL`;
    }
    case "range": case "add": {
      const buy = Number(body.buy), sell = Number(body.sell), steps = Math.max(1, Math.min(20, Math.trunc(Number(body.steps ?? 3))));
      if (!(buy > 0 && sell > buy)) throw new Error("need 0 < buy < sell (USD market cap)");
      const { text } = rangeFileBody("usd", String(buy), String(sell), steps);
      const p = rangePath(w, m); writeFileSync(`${p}.tmp`, text); renameSync(`${p}.tmp`, p);
      if (action === "range") updateBot(root, w, m, { rangeLocked: true });
      if (action === "add") {
        const budget = Number(body.budget ?? 0.05);
        if (!(budget > 0 && budget <= 1)) throw new Error("budget must be between 0 and 1 SOL");
        addBot(root, { wallet: w, mint: m, amount: String(budget), mode: "target", rangeLocked: true }); // a range you typed stays yours
        const list = onlyList(); if (list) writeFileSync(onlyPath(), JSON.stringify([...new Set([...list, m])]));
        return "position opened";
      }
      return "range saved";
    }
    default: throw new Error(`unknown action ${String(action)}`);
  }
}

const dist = join(root, "web", "dist");
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const port = Number(process.env.SLRD_BRIDGE_PORT ?? 5174);
Bun.serve({
  hostname: "127.0.0.1", port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      // Same-origin page only: the token travels in a header, never in a cookie, so other sites cannot use it.
      if (req.headers.get("x-slrd-token") !== token) return json({ error: "bad token" }, 401);
      try {
        if (url.pathname === "/api/state") return json(state());
        if (url.pathname === "/api/wallets") return json(walletsApi(url));
        if (url.pathname === "/api/wallet") { const w = url.searchParams.get("addr"); return validMint(w) ? json(walletApi(w!)) : json({ error: "addr" }, 400); }
        if (url.pathname === "/api/coin-wallets") { const m = url.searchParams.get("mint"); return validMint(m) ? json(await coinWalletsApi(m!, url.searchParams.get("watch") !== "0")) : json({ error: "mint" }, 400); }
        if (url.pathname === "/api/coin") { const m = url.searchParams.get("mint"); return validMint(m) ? json(await coinApi(m!)) : json({ error: "mint" }, 400); }
        if (url.pathname === "/api/discovery") {
          let d: { coins: Array<{ mint: string; symbol?: string | null }>; decisions: Array<{ mint: string; symbol?: string | null }>; firehose: unknown };
          try { d = JSON.parse(readFileSync(join(root, ".range-bots", "discovery.json"), "utf8")); } catch { return json({ coins: [], decisions: [], firehose: null }); }
          const sym = symbols(); // tickers the firehose missed (coin launched before the daemon started)
          for (const x of [...d.coins, ...d.decisions]) x.symbol = x.symbol || sym[x.mint] || null;
          return json(d);
        }
        if (url.pathname === "/api/trades") { const m = url.searchParams.get("mint"); return validMint(m) ? json(readTrades(root, m!)) : json({ error: "mint" }, 400); }
        if (url.pathname === "/api/bot" && req.method === "POST") return json({ ok: true, message: await act(await req.json() as Record<string, unknown>) });
      } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 400); }
      return json({ error: "not found" }, 404);
    }
    const file = Bun.file(join(dist, url.pathname === "/" ? "index.html" : url.pathname.slice(1).replace(/\.\.+/g, "")));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
console.log(`slrd bridge: http://127.0.0.1:${port}/#token=${token}`);
