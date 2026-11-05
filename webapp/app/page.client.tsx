/** @jsxImportSource tradjs/client */
/** The single page: positions (left), the selected coin's stats + trade map + wallets + live trades (middle),
 * new and migrated coins (right). Hovering a trade or wallet highlights it everywhere; clicking any coin selects it.
 * Polls /api/overview every 3s and /api/coin every 2s; the selection is kept in ?coin=. */
import { render } from "tradjs/client";
import { drawTradeMap, hitDot, dotTip, type Dot, type MapHistory } from "../../web/trade-map.ts";
import { bundledWallets } from "../../tui/bundles.ts";

type Bot = { wallet: string; mint: string; symbol?: string | null; capUsd?: number | null; range?: { unit: string; buy: number; sell: number } | null; steps?: number;
  holdingSteps?: number; target?: number; budgetSol?: number; base: number; mult: number; valueSol?: number | null; pnl: number; flowSol: number; source: string; buysPaused: boolean;
  error: string | null; stale: boolean; nextBuy?: number | null; nextSell?: number | null; addedAt?: number | null; lastTradeAtMs?: number | null; vol1hSol?: number | null; vol5mSol?: number | null; volCoveredMin?: number | null; amountRaw?: string | null; priceSol?: number | null; costSol?: number | null; rangeLocked?: boolean; inactive?: boolean };
type Coin = { mint: string; symbol: string | null; ageMs: number | null; capUsd: number | null; ammCapUsd?: number | null; trades: number; traders?: number; smart?: number; lastTradeMs: number; status: string; migrated: boolean };
type ClosedRow = { mint: string; symbol: string | null; closedAt: number; openedAt: number | null; boughtSol: number; buys: number; sells: number; pnlSol: number; pct: number | null };
type Overview = { at: number; closed?: { sol: number; bots: number }; closedRows?: ClosedRow[]; solUsd: number | null; bots: Bot[]; coins: Coin[]; firehose: { liveCoins: number; perSec: number; lagMs: number } | null; feedLagMs: number | null };
type W = { trader: string; held: number; pct: number; buys: number; sells: number; solIn: number; solOut: number; pnlSol: number; lastAtMs: number; entryCapUsd: number | null;
  delta5: { tokens: number } | null; ours: string | null; dev: boolean; from?: string | null; viaTransfer?: boolean;
  smart: { realizedSol: number; winRate: number; coins: number; style?: string; medMultiple?: number | null; medEntryCapUsd?: number | null; medExitCapUsd?: number | null; medHoldMin?: number; medBuySol?: number; medRoundTrips?: number } | null;
  profile: { coins: number; wins: number; trades?: number; volumeSol?: number; pnlSol: number; realizedSol: number; medEntryCap: number | null; medExitCap: number | null; medMultiple: number | null; medHoldMin: number | null; avgRankPct: number } | null };
type T = { signature: string; atMs: number; side: string; sol: number | null; tokens: number | null; capUsd: number | null; trader: string | null; smart: boolean; ours: string | null };
type Xfer = { atMs: number; signature: string | null; from: string[]; to: string[]; amount: number };
type CoinData = { mint: string; symbol: string | null; capUsd: number | null; migrated: boolean | null; launchedAtMs: number | null; walletCount: number; holders: number; wallets: W[]; recent: T[]; creator: string | null;
  exact?: boolean; clusters?: { source: string; members: number; pct: number }[]; transfers?: Xfer[]; transferCount?: number };

const $ = (id: string) => document.getElementById(id)!;
/** 290541 -> 290.5k tokens. */
const fmtTokens = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(0);
/** Volume: $420, $3.2k, $1.40M. */
const usdSmall = (v: number) => v < 1_000 ? `${Math.round(v)}` : usd(v);
const usd = (v?: number | null) => v == null || !Number.isFinite(v) ? "—" : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1e3).toFixed(1)}k`;
const ago = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`;
const short = (s: string, n = 4) => `${s.slice(0, n)}…${s.slice(-n)}`;
const sgn = (v: number, d = 4) => <span className={v >= 0 ? "up" : "dn"}>{v >= 0 ? "+" : "−"}{Math.abs(v).toFixed(d)}</span>;
const tok = (v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : v.toFixed(0);

/** Market makers / arbitrage bots: dozens of round trips on both sides in this coin. They hold big and trade
 * constantly, which reads like the pool itself; hidden from the holder list unless toggled. */
const isBot = (w: { buys: number; sells: number }) => w.buys + w.sells >= 40 && Math.min(w.buys, w.sells) >= 15;
const qs = new URLSearchParams(location.search);
/** ?embed=1: the terminal inside another page on this site. That page can find a coin's row and open a coin; nothing else. */
const EMBED = qs.get("embed") === "1";
const EMBED_PARENTS = new Set([location.origin, "https://krisagent.xyz"]);
const embedParent = () => { try { const o = new URL(document.referrer).origin; return EMBED_PARENTS.has(o) ? o : location.origin; } catch { return location.origin; } };
let embedReady = false;
const S = { kris: null as { wallet?: string; stats?: { volumeSol: number } | null } | null, sortKey: qs.get("sort") ?? (qs.get("agent") ? "last" : "pnl"), sortDir: qs.get("dir") === "asc" ? 1 : -1, showBots: false, coin: new URLSearchParams(location.search).get("coin"), filter: "all", hover: null as string | null, pin: null as string | null,
  ov: null as Overview | null, cd: null as CoinData | null };
let dots: Dot[] = [];

function select(mint: string) {
  copy(mint); toast("CA copied"); open(mint);
}
function open(mint: string) {
  if (S.coin === mint) return;
  coinBusy = false;
  S.coin = mint; S.cd = null; S.pin = null; { const q = new URLSearchParams(location.search); q.set("coin", mint); history.replaceState(null, "", `?${q}`); } void pullCoin(); draw();
}
const copy = (text: string) => void navigator.clipboard?.writeText(text);
/** The open position's range in dollars, for the chart. */
function rangeOf(mint: string) {
  const r = S.ov?.bots.find(b => b.mint === mint)?.range as { unit?: string; buy: number; sell: number; steps?: number } | null | undefined;
  return r && r.unit === "usd" && r.steps ? { buy: r.buy, sell: r.sell, steps: r.steps } : null;
}
/** Finished positions, newest first. Click one to open its coin. */
function ClosedList({ rows }: { rows: ClosedRow[] }) {
  if (!rows.length) return <div className="dim" style={{ padding: "12px" }}>No closed positions yet.</div>;
  return <table><thead><tr><th>COIN</th><th className="r">CLOSED</th><th className="r">HELD</th><th className="r">BOUGHT</th><th className="r">TRADES</th><th className="r">P&amp;L</th><th className="r">%</th></tr></thead>
    <tbody>{rows.map(c => <tr key={`${c.mint}${c.closedAt}`} className={`row${S.coin === c.mint ? " sel" : ""}`} data-mint={c.mint}>
      <td><b>{c.symbol ?? short(c.mint)}</b></td><td className="num r dim">{ago(Date.now() - c.closedAt)}</td><td className="num r dim">{c.openedAt ? ago(c.closedAt - c.openedAt) : "—"}</td>
      <td className="num r">{c.boughtSol ? c.boughtSol.toFixed(3) : "—"}</td><td className="num r dim">{c.buys + c.sells || "—"}</td>
      <td className={`num r ${c.pnlSol >= 0 ? "up" : "dn"}`}>{c.pnlSol >= 0 ? "+" : ""}{c.pnlSol.toFixed(4)}</td><td className={`num r ${c.pnlSol >= 0 ? "up" : "dn"}`}>{c.pct == null ? "—" : `${c.pct >= 0 ? "+" : ""}${c.pct.toFixed(0)}%`}</td></tr>)}</tbody></table>;
}

// ---------- left: positions ----------
/** Hourly volume as a share of market cap: $50k an hour means far more on a $100k coin than on a $5M one. */
const volToCap = (b: Bot) => b.vol5mSol != null && b.capUsd && S.ov?.solUsd ? b.vol5mSol * S.ov.solUsd / b.capUsd : null;
function Positions({ bots }: { bots: Bot[] }) {
  // Click a header to sort by it; again to flip the direction (kept in the URL).
  const rangePos = (b: Bot) => b.range && b.capUsd ? (b.capUsd - b.range.buy) / (b.range.sell - b.range.buy) : -Infinity;
  const key: Record<string, (b: Bot) => number | string> = { coin: b => (b.symbol ?? b.mint).toLowerCase(), mcap: b => b.capUsd ?? -1, range: rangePos,
    held: b => (b.holdingSteps ?? 0) / (b.steps || 1), size: b => b.budgetSol ?? b.base, pnl: b => b.pnl, value: b => b.valueSol ?? 0, holding: b => b.valueSol ?? 0,
    state: b => b.error ? "0" + b.error : b.buysPaused ? "1" : (b.valueSol ?? 0) > 0 ? "2" : "3", source: b => b.source,
    vol: b => volToCap(b) ?? -1, added: b => b.addedAt ?? 0, last: b => b.lastTradeAtMs ?? 0 };
  const k = key[S.sortKey] ?? key.pnl!;
  const list = bots.filter(b => S.filter === "all" || (S.filter === "holding" ? (b.valueSol ?? 0) > 0 : S.filter === "smart" ? b.source === "smart" : b.pnl < -0.0005))
    .sort((a, b) => { const x = k(a), y = k(b); return (x < y ? -1 : x > y ? 1 : 0) * S.sortDir; });
  const th = (id: string, label: string, right = false) => <th className={`sortable${right ? " r" : ""}${S.sortKey === id ? " on" : ""}`} data-sort={id}>{label}{S.sortKey === id ? (S.sortDir < 0 ? " ▼" : " ▲") : ""}</th>;
  return <table>
    <thead><tr>{th("coin", "COIN")}{th("mcap", "MCAP", true)}{th("vol", "VOL 5M", true)}{th("range", "RANGE")}{th("held", "HELD", true)}{th("holding", "HOLDING", true)}{th("size", "SIZE", true)}{th("pnl", "P&L SOL", true)}{th("added", "ADDED", true)}{th("last", "LAST TRADE", true)}{th("state", "STATE")}</tr></thead>
    <tbody>{list.map(b => {
      const r = b.range, pos = r && b.capUsd ? Math.max(0, Math.min(1, (b.capUsd - r.buy) / (r.sell - r.buy))) : null;
      const state = b.inactive ? <span className="dim" title="not running: last known numbers, nothing will sell or buy this until it runs again">inactive</span> : b.error ? <span className="chip c-err" title={b.error}>{b.error.slice(0, 18)}</span>
        : <span className="dim" title={b.buysPaused ? "buys paused: this bot only sells" : undefined}>{[b.buysPaused ? "buys paused" : (b.target ?? 0) > (b.holdingSteps ?? 0) ? `buying now (${(b.target ?? 0) - (b.holdingSteps ?? 0)} of ${b.steps ?? 0} steps)` : b.nextBuy ? `buy ${usd(b.nextBuy)}` : "", b.nextSell && (b.valueSol ?? 0) > 0 ? `sell ${usd(b.nextSell)}` : ""].filter(Boolean).join(" · ")}{b.steps === 1 && (b.valueSol ?? 0) > 0 ? " (break-even)" : ""}</span>;
      return <tr key={b.mint} className={`row${S.coin === b.mint ? " sel" : ""}${b.inactive ? " inactive" : ""}`} data-mint={b.mint}>
        <td><b>{(b.symbol ?? short(b.mint)).slice(0, 12)}</b>{b.source === "manual" ? null : <span> <span className={`chip c-${b.source}`}>{b.source === "migration" ? "migr" : b.source}</span></span>}</td>
        <td className="num r">{usd(b.capUsd)}</td>
        <td className="num r" title={b.vol5mSol != null ? `${b.vol5mSol.toFixed(1)} SOL traded in the last 5 minutes${volToCap(b) != null ? `, ${Math.round(volToCap(b)! * 100)}% of market cap` : ""}${b.vol1hSol != null ? `. ${b.vol1hSol.toFixed(1)} SOL in the last hour` : ""}` : ""}>{b.vol5mSol != null && S.ov?.solUsd ? usdSmall(b.vol5mSol * S.ov.solUsd) : "—"}</td>
        <td className="num">{r ? <span title={`${usd(r.buy)} → ${usd(r.sell)}`}><span className="bar"><span className="fill" style={{ width: `${Math.round((b.holdingSteps ?? 0) / (b.steps || 1) * 72)}px` }} />{pos != null && <i style={{ left: `${Math.round(pos * 69)}px` }} />}</span></span> : "—"}</td>
        <td className="num r">{b.holdingSteps ?? 0}/{b.steps ?? "?"}</td>
        <td className="num r" title={b.costSol != null ? `cost ${b.costSol.toFixed(4)} SOL${b.valueSol != null ? ` · now ${b.valueSol.toFixed(4)} SOL` : ""}` : ""}>{b.valueSol ? <>{b.valueSol.toFixed(4)}<span className="dim"> · {fmtTokens(b.valueSol && b.priceSol ? b.valueSol / b.priceSol : 0)}</span></> : <span className="dim">—</span>}</td>
        <td className="num r" title={`your size ${b.base} SOL × ${b.mult} (smart wallets)`}>{(b.budgetSol ?? b.base).toFixed(3)}{b.mult !== 1 ? <span className={b.mult > 1 ? "up" : "dn"}> ×{b.mult}</span> : ""}</td>
        <td className="num r">{sgn(b.pnl)}</td>
        <td className="num r dim" title={b.addedAt ? new Date(b.addedAt).toLocaleString() : ""}>{b.addedAt ? ago(Date.now() - b.addedAt) : "—"}</td>
        <td className="num r dim" title={b.lastTradeAtMs ? new Date(b.lastTradeAtMs).toLocaleString() : "no trade since this was added"}>{b.lastTradeAtMs ? ago(Date.now() - b.lastTradeAtMs) : "—"}</td>
        <td className="state">{state}</td></tr>;
    })}</tbody></table>;
}

// ---------- middle: selected coin ----------
function CoinStats({ cd }: { cd: CoinData }) {
  const smartHold = cd.wallets.filter(w => w.smart && w.held > 0).length, smartOut = cd.wallets.filter(w => w.smart && w.held <= 0).length;
  const top10 = cd.wallets.slice(0, 10).reduce((a, w) => a + w.pct, 0);
  const t0 = cd.launchedAtMs ?? Math.min(...cd.wallets.map(w => w.lastAtMs)), early = cd.wallets.filter(w => w.entryCapUsd != null && cd.launchedAtMs && w.lastAtMs - t0 < 3000).reduce((a, w) => a + w.pct, 0);
  const st = (k: string, v: any) => <div><div className="k">{k}</div><div className="v num">{v}</div></div>;
  return <>{st("MCAP", usd(cd.capUsd))}{st("STAGE", cd.migrated ? "migrated" : cd.migrated === false ? "curve" : "—")}{st("AGE", cd.launchedAtMs ? ago(Date.now() - cd.launchedAtMs) : "—")}
    {st("WALLETS", `${cd.walletCount} · ${cd.holders} holding`)}{st("TOP 10", <span className={top10 > 70 ? "dn" : ""}>{top10.toFixed(1)}%</span>)}
    {st("★ HOLDING / OUT", <span><span className="amb">{smartHold}</span> / {smartOut}</span>)}{early > 0 ? st("FIRST 3s", <span className={early > 25 ? "dn" : ""}>{early.toFixed(1)}%</span>) : null}
    {st("HOLDINGS", cd.exact ? <span className="up" title="from token balances: transfers included">exact</span> : <span className="amb" title="from trades only, until the token-balance backfill is done">estimate…</span>)}
    {cd.transferCount ? st("TRANSFERS", cd.transferCount) : null}
    {(() => { const b = bundledWallets(cd.recent); if (!b.size) return null; const pct = cd.wallets.filter(w => b.has(w.trader)).reduce((a, w) => a + w.pct, 0);
      return st("BUNDLE BUYS", <span className="dn" title="wallets that bought within ~1s of each other for the same SOL">{b.size} wallets · {pct.toFixed(1)}%</span>); })()}
    {(cd.clusters ?? []).length ? st("CLUSTERS", <span title={(cd.clusters ?? []).slice(0, 6).map(x => `${short(x.source, 4)} funded ${x.members} wallets holding ${x.pct.toFixed(1)}%`).join("\n")}
      className={(cd.clusters![0]!.pct) > 20 ? "dn" : ""}>{cd.clusters![0]!.members} wallets from {short(cd.clusters![0]!.source, 4)} = {cd.clusters![0]!.pct.toFixed(1)}%</span>) : null}</>;
}
const tags = (w: { smart?: unknown; ours?: string | null; dev?: boolean; trader?: string | null }, creator: string | null) => <>
  {w.smart ? <span className="chip c-smart" title={(w.smart as any)?.style ?? "followable"}>★</span> : null}
  {w.dev || (creator && w.trader === creator) ? <span className="chip c-dev">DEV</span> : null}
  {w.ours ? <span className="chip c-ours">{w.ours}</span> : null}</>;
/** Lifetime score of a wallet: realized SOL over the coins we recorded, win rate; the star = on the follow list. */
const volSol = (v: number) => `${v >= 100 ? Math.round(v) : v.toFixed(1)} SOL`;
function Score({ w }: { w: W }) {
  const p = w.profile, s = w.smart;
  if (!p && !s) return <span className="dim">new</span>;
  const real = s?.realizedSol ?? p!.realizedSol, coins = s?.coins ?? p!.coins, win = s ? s.winRate : p!.coins ? p!.wins / p!.coins : 0;
  return <span><span className={real >= 0 ? "up" : "dn"}>{real >= 0 ? "+" : "−"}{Math.abs(real).toFixed(real >= 10 ? 0 : 1)}</span><span className="dim"> · {coins} {coins === 1 ? "coin" : "coins"} · {Math.round(win * 100)}%{p?.volumeSol != null ? ` · ${volSol(p.volumeSol)} vol` : ""}</span></span>;
}
/** Hover text: how this wallet usually trades. */
function profileText(w: W) {
  const p = w.profile, s = w.smart, k = (v?: number | null) => v == null || !Number.isFinite(v) ? "—" : usd(v);
  if (!p && !s) return "No history: first coin we recorded for this wallet.";
  const mult = s?.medMultiple ?? p?.medMultiple;
  const lines = [
    s ? `★ followable · style ${s.style ?? "—"}` : "not on the follow list",
    `realized ${(s?.realizedSol ?? p!.realizedSol).toFixed(2)} SOL over ${s?.coins ?? p!.coins} coins · ${Math.round((s ? s.winRate : p!.coins ? p!.wins / p!.coins : 0) * 100)}% in profit`,
    p?.volumeSol != null ? `traded ${volSol(p.volumeSol)} across ${p.coins} coins in ${p.trades ?? 0} trades` : "",
    `usually enters ~${k(s?.medEntryCapUsd ?? p?.medEntryCap)} -> exits ~${k(s?.medExitCapUsd ?? p?.medExitCap)} (median x${mult != null ? mult.toFixed(2) : "—"})`,
    `median hold ${Math.round(s?.medHoldMin ?? p?.medHoldMin ?? 0)} min${s?.medBuySol != null ? ` · median buy ${s.medBuySol.toFixed(2)} SOL` : ""}${s?.medRoundTrips != null ? ` · ${s.medRoundTrips} round trip(s) per coin` : ""}`,
    p && Number.isFinite(p.avgRankPct) ? `buys on average within the first ${Math.round(p.avgRankPct)}% of buyers` : "",
  ];
  return lines.filter(Boolean).join("\n");
}
function Wallets({ cd }: { cd: CoinData }) {
  const hl = S.hover ?? S.pin, bundle = bundledWallets(cd.recent);
  return <table><thead><tr><th>WALLET</th><th className="r">HOLDS</th><th className="r">%</th><th className="r">5 MIN</th><th className="r">P&amp;L</th><th className="r">B/S</th><th>SCORE (lifetime)</th></tr></thead>
    <tbody>{cd.wallets.filter(w => w.held > 0 && (S.showBots || !isBot(w))).slice(0, 120).map(w => <tr key={w.trader} className={`row${hl === w.trader ? " hl" : ""}`} data-w={w.trader} title={profileText(w)}>
      <td className="num"><a href={`https://gmgn.ai/sol/address/${w.trader}`} target="_blank" rel="noreferrer">{short(w.trader, 4)}</a> {tags(w, cd.creator)}{isBot(w) ? <span className="chip c-manual">BOT/MM</span> : null}{bundle.has(w.trader) ? <span className="chip c-dev" title="bought in the same second as 2+ other wallets for the same SOL: one operator">BUNDLE</span> : null}{w.from ? <span className="chip c-dev" title={`first tokens came by transfer from ${w.from}`}>↳ {short(w.from, 4)}</span> : null}</td>
      <td className="num r">{tok(w.held)}</td><td className="num r">{w.pct.toFixed(2)}</td>
      <td className="num r">{w.delta5 ? <span className={w.delta5.tokens >= 0 ? "up" : "dn"}>{w.delta5.tokens >= 0 ? "▲" : "▼"}{tok(Math.abs(w.delta5.tokens))}</span> : ""}</td>
      <td className="num r">{sgn(w.pnlSol, 2)}</td><td className="num r dim">{w.buys}/{w.sells}</td><td className="num"><Score w={w} /></td></tr>)}</tbody></table>;
}
function Trades({ cd }: { cd: CoinData }) {
  const hl = S.hover ?? S.pin, bots = new Set(cd.wallets.filter(isBot).map(w => w.trader)), bundle = bundledWallets(cd.recent);
  return <table><thead><tr><th>TIME</th><th>SIDE</th><th className="r">SOL</th><th className="r">MCAP</th><th>WALLET</th></tr></thead>
    <tbody>{[...cd.recent.slice(0, 120).map(t => ({ kind: "trade" as const, at: t.atMs, t })), ...(cd.transfers ?? []).slice(0, 60).map(x => ({ kind: "xfer" as const, at: x.atMs, x }))]
      .sort((a, b) => b.at - a.at).slice(0, 150).map(row => row.kind === "xfer"
        ? <tr key={"x" + row.at + row.x.from.join()} className={`row${hl && (row.x.from.includes(hl) || row.x.to.includes(hl)) ? " hl" : ""}`} data-w={row.x.to[0] ?? ""}>
            <td className="num dim">{new Date(row.at).toLocaleTimeString([], { hour12: false })}</td><td><b className="amb">XFER</b></td>
            <td className="num r">{tok(row.x.amount)}</td><td className="num r dim">tokens</td>
            <td className="num" title={`${row.x.from.join(", ")} -> ${row.x.to.join(", ")}`}>{short(row.x.from[0]!, 4)} → {short(row.x.to[0]!, 4)}{row.x.to.length > 1 ? ` +${row.x.to.length - 1}` : ""}</td></tr>
        : (t =>  <tr key={t.signature + (t.trader ?? "")} className={`row${hl && hl === t.trader ? " hl" : ""}${t.trader && bots.has(t.trader) ? " botrow" : ""}`} data-w={t.trader ?? ""}>
      <td className="num dim">{new Date(t.atMs).toLocaleTimeString([], { hour12: false })}</td>
      <td><b className={t.side === "buy" ? "up" : "dn"}>{t.side.toUpperCase()}</b></td>
      <td className="num r">{t.sol == null ? "—" : t.sol.toFixed(3)}</td><td className="num r">{usd(t.capUsd)}</td>
      <td className="num">{t.trader ? short(t.trader, 4) : "—"} {tags(t, cd.creator)}{t.trader && bots.has(t.trader) ? <span className="chip c-manual">BOT/MM</span> : null}{t.trader && bundle.has(t.trader) ? <span className="chip c-dev">BUNDLE</span> : null}</td></tr>)(row.t))}</tbody></table>;
}

// ---------- right: new and migrated coins ----------
function CoinList({ coins }: { coins: Coin[] }) {
  return <table><thead><tr><th>COIN</th><th className="r">AGE</th><th className="r">MCAP</th><th className="r">TRADES</th><th className="r">★</th></tr></thead>
    <tbody>{coins.slice(0, 40).map(c => <tr key={c.mint} className={`row${S.coin === c.mint ? " sel" : ""}`} data-mint={c.mint}>
      <td>{c.status === "ours" ? "◆ " : ""}<b>{(c.symbol ?? short(c.mint)).slice(0, 12)}</b></td><td className="num r dim">{c.ageMs == null ? "—" : ago(c.ageMs)}</td>
      <td className="num r">{usd(c.migrated ? c.ammCapUsd ?? c.capUsd : c.capUsd)}</td><td className="num r">{c.trades}</td><td className="num r amb">{c.smart ? `★${c.smart}` : ""}</td></tr>)}</tbody></table>;
}
// ---------- draw ----------
function draw() {
  const ov = S.ov;
  if (ov) {
    const holding = ov.bots.filter(b => (b.valueSol ?? 0) > 0), pnl = ov.bots.reduce((a, b) => a + b.pnl, 0), ok = ov.bots.filter(b => !b.error && !b.stale && !b.inactive).length;
    render(<>
      {S.kris?.wallet ? <span>wallet <a className="v" href={`https://solscan.io/account/${S.kris.wallet}`} target="_blank" rel="noopener">{S.kris.wallet.slice(0, 6)}…{S.kris.wallet.slice(-4)}</a></span> : null}
      {S.kris?.stats?.volumeSol ? <span>traded <span className="v">{Math.round(S.kris.stats.volumeSol).toLocaleString("en-US")} SOL</span></span> : null}
      <span>bots <span className="v">{ok}/{ov.bots.length}</span> ok</span>
      <span>holding <span className="v">{holding.reduce((a, b) => a + (b.valueSol ?? 0), 0).toFixed(3)} SOL</span> in {holding.length}</span>
      {(() => { const closedSol = ov.closed?.sol ?? 0, total = pnl + closedSol; return <span>P&amp;L <span className="v">{sgn(total, 3)} SOL</span>{ov.solUsd ? <span className="dim"> ({total >= 0 ? "+" : "−"}${Math.abs(total * ov.solUsd).toFixed(0)})</span> : null}<span className="dim" title={`${ov.closed?.bots ?? 0} closed bots`}> · open {sgn(pnl, 3)} · closed {sgn(closedSol, 3)}</span></span>; })()}
      <span>SOL <span className="v">${ov.solUsd?.toFixed(2) ?? "—"}</span></span>
      {ov.firehose ? <span>firehose <span className="v">{ov.firehose.perSec.toFixed(0)}/s</span> lag {(ov.firehose.lagMs / 1000).toFixed(0)}s</span> : null}
    </>, $("stats"));
    $("pos-sub").textContent = `${ov.bots.length}`;
    render(<Positions bots={ov.bots} />, $("positions"));
    { const rows = ov.closedRows ?? [], wins = rows.filter(r => r.pnlSol > 0).length; $("closed-sub").textContent = rows.length ? `${rows.length} · ${wins} won · ${(rows.reduce((a, r) => a + r.pnlSol, 0)).toFixed(3)} SOL` : ""; render(<ClosedList rows={rows} />, $("closed")); }
    const fresh = ov.coins.filter(c => !c.migrated), mig = ov.coins.filter(c => c.migrated);
    $("new-sub").textContent = `${fresh.length}`; $("mig-sub").textContent = `${mig.length}`;
    render(<CoinList coins={fresh} />, $("disc-new")); render(<CoinList coins={mig} />, $("disc-mig"));
  }
  const cd = S.cd;
  if (cd && cd.mint === S.coin) {
    render(<span>{cd.symbol ?? short(cd.mint)} <button className="copy" onClick={() => copy(cd.mint)}>copy CA</button></span>, $("coin-title"));
    render(<span><label className="dim" style={{ marginRight: "10px", cursor: "pointer" }}><input type="checkbox" checked={S.showBots} onChange={() => { S.showBots = !S.showBots; draw(); }} /> show bots/MM ({cd.wallets.filter(w => w.held > 0 && isBot(w)).length})</label><a href={`https://dexscreener.com/solana/${cd.mint}`} target="_blank" rel="noreferrer">DexScreener ↗</a> · <a href={`https://gmgn.ai/sol/token/${cd.mint}`} target="_blank" rel="noreferrer">GMGN ↗</a></span>, $("coin-links"));
    render(<CoinStats cd={cd} />, $("coin-stats"));
    render(<Wallets cd={cd} />, $("coin-wallets")); render(<Trades cd={cd} />, $("coin-trades"));
    dots = drawTradeMap($("map") as HTMLCanvasElement, [...cd.recent].reverse() as never, S.hover ?? S.pin, "No trades or saved candles for this coin yet.", { candles: (cd as unknown as MapHistory).candles, fills: (cd as unknown as MapHistory).fills, range: rangeOf(cd.mint) });
  } else if (!S.coin) render(<span className="dim">Click a position or a coin</span>, $("coin-stats"));
}

function toast(text: string, bad = false) {
  const t = document.createElement("div"); t.className = `toast${bad ? " bad" : ""}`; t.textContent = text; document.body.appendChild(t);
  setTimeout(() => t.remove(), 3_500);
}
async function pullOverview() {
  try {
    S.ov = await (await fetch("api/overview")).json(); draw();
    if (EMBED && !embedReady) { embedReady = true; parent.postMessage({ type: "solard:ready" }, embedParent()); }
  } catch {}
}
function onEmbed(e: MessageEvent) {
  if (!EMBED_PARENTS.has(e.origin) || e.source !== parent) return;
  const { type, mint, id, target } = (e.data ?? {}) as { type?: string; mint?: string; id?: number; target?: string };
  const box = (el: Element | null) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  // Tabs and sort headers only: the page has no trading controls, and these two selectors can reach nothing else.
  if (type === "solard:press" || type === "solard:locate-target") {
    const m = /^(filter|sort|panel):([a-z]+)$/.exec(target ?? ""); if (!m) return;
    const panels: Record<string, string> = { wallets: "coin-wallets", trades: "coin-trades", newcoins: "disc-new", migrated: "disc-mig", stats: "coin-stats" };
    const el = (m[1] === "panel" ? document.getElementById(panels[m[2]!] ?? "") : document.querySelector(m[1] === "filter" ? `#pos-filter button[data-f="${m[2]}"]` : `th[data-sort="${m[2]}"]`)) as HTMLElement | null;
    if (type === "solard:press" && m[1] !== "panel") el?.click();
    parent.postMessage({ type: "solard:at", id, target: box(el) }, e.origin); return;
  }
  if ((type !== "solard:locate" && type !== "solard:open") || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint ?? "")) return;
  if (type === "solard:open") open(mint!);
  const row = document.querySelector(`tr.row[data-mint="${mint}"]`) ?? document.querySelector(`[data-mint="${mint}"]`); row?.scrollIntoView({ block: "nearest" });
  parent.postMessage({ type: "solard:at", id, row: box(row), range: box(row?.querySelector("td:nth-child(4)") ?? null), chart: box($("map")) }, e.origin);
}
// One request at a time; a reply for a coin that is no longer selected is dropped (it used to overwrite the new one).
let coinBusy = false;
async function pullCoin() {
  const mint = S.coin; if (!mint || coinBusy) return; coinBusy = true;
  try { const r = await fetch(`api/coin?mint=${mint}${EMBED ? "&watch=0" : ""}`, { signal: AbortSignal.timeout(20_000) }); if (r.ok) { const j = await r.json(); if (S.coin === mint) { S.cd = j; draw(); } } }
  catch {} finally { coinBusy = false; }
}

const loadKris = () => fetch("api/kris").then(r => r.ok ? r.json() : null).then(d => { if (d) { S.kris = { wallet: d.wallet, stats: d.stats }; draw(); } }).catch(() => {});
export default function mount() {
  // One delegated handler: any row with data-mint selects that coin; rows with data-w highlight that wallet.
  const onClick = (e: Event) => {
    const t = e.target as HTMLElement;
    const h = t.closest("th[data-sort]") as HTMLElement | null;
    if (h) {
      const id = h.dataset.sort!;
      if (S.sortKey === id) S.sortDir = -S.sortDir as 1 | -1; else { S.sortKey = id; S.sortDir = id === "coin" || id === "state" ? 1 : -1; } // added / last trade: newest first
      const q = new URLSearchParams(location.search); q.set("sort", S.sortKey); q.set("dir", S.sortDir > 0 ? "asc" : "desc"); history.replaceState(null, "", `?${q}`);
      draw(); return;
    }
    const f = t.closest("#pos-filter button") as HTMLElement | null;
    if (f) { S.filter = f.dataset.f!; for (const b of document.querySelectorAll("#pos-filter button")) b.classList.toggle("on", b === f); draw(); return; }
    const m = t.closest("[data-mint]") as HTMLElement | null; if (m && !t.closest("a,button")) select(m.dataset.mint!);
  };
  const onOver = (e: Event) => { const w = (e.target as HTMLElement).closest("[data-w]") as HTMLElement | null; const v = w?.dataset.w || null; if (v !== S.hover) { S.hover = v; draw(); } };
  document.addEventListener("click", onClick); $("coin-wallets").addEventListener("mouseover", onOver); $("coin-trades").addEventListener("mouseover", onOver);
  for (const id of ["coin-wallets", "coin-trades"]) $(id).addEventListener("mouseleave", () => { S.hover = null; draw(); });
  const c = $("map") as HTMLCanvasElement, tip = $("tip");
  c.addEventListener("mousemove", e => { const d = hitDot(dots, c, e); if (!d) { tip.style.display = "none"; return; } tip.style.display = "block"; tip.style.left = `${e.clientX + 12}px`; tip.style.top = `${e.clientY + 12}px`; tip.innerHTML = dotTip(d, "click to pin this wallet"); });
  c.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  c.addEventListener("click", e => { S.pin = hitDot(dots, c, e)?.t.trader ?? null; draw(); });
  // Opens as soon as a mint is pasted or typed (no Enter needed); links from pump.fun, DexScreener, GMGN, Solscan,
  // Birdeye... work too: the first base58 string of mint length in the text is taken.
  const search = $("search") as HTMLInputElement;
  const openFrom = (text: string) => {
    const m = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g)?.find(x => x.length >= 32);
    if (!m) return false;
    select(m); search.value = m; search.blur(); return true;
  };
  search.addEventListener("paste", e => { const t = (e as ClipboardEvent).clipboardData?.getData("text") ?? ""; if (openFrom(t)) e.preventDefault(); });
  search.addEventListener("input", () => { void openFrom(search.value); });
  search.addEventListener("keydown", e => { if ((e as KeyboardEvent).key === "Enter") void openFrom(search.value); });
  void pullOverview(); void pullCoin();
  void loadKris(); const krisTimer = setInterval(() => void loadKris(), 60_000);
  const a = setInterval(() => void pullOverview(), 3_000), b = setInterval(() => void pullCoin(), 2_000);
  if (EMBED) window.addEventListener("message", onEmbed);
  return () => { clearInterval(a); clearInterval(krisTimer); clearInterval(b); window.removeEventListener("message", onEmbed); document.removeEventListener("click", onClick); };
}
