/** SOLARD terminal in the browser. Two data sources, one UI:
 *  - bridge: the local slrd-bots daemon via slrd-bridge.ts on 127.0.0.1 (wallets, positions, P&L, trades, actions)
 *  - browser: no server at all; coins kept in localStorage, live trades straight from SQD + the user's RPC. */
import "./polyfills.ts"; // must stay first: Buffer/process for the SDK code
import { Connection } from "@solana/web3.js";
import { subscribeTrades, type TradeEvent } from "../packages/core/src/market/launch-trades.ts";
import { rangeLevels, targetPlan } from "../packages/core/src/runtime/target-inventory.ts";
import { copyCell, installCopy } from "./copy.ts";

// ---------- shared shapes ----------
type Wallet = { name: string; address: string; sol: number | null };
type Bot = {
  wallet: string; mint: string; symbol?: string | null; alive: boolean; capUsd: number | null;
  range: { unit: "usd" | "sol"; buy: number; sell: number } | null; steps?: number; holdingSteps?: number;
  nextSell?: number | null; nextBuy?: number | null; paused?: string | null; pending?: string | null; health?: string | null;
  costSol?: number | null; valueSol?: number | null; pnlSol?: number | null; auto?: boolean; last?: string | null; budgetSol?: number; target?: number | null;
};
type Trade = { signature: string; atMs: number; side: "buy" | "sell" | null; sol: number | null; capUsd: number | null; trader: string | null };
type State = { wallets: Wallet[]; bots: Bot[]; solUsd: number | null; daemon: { pid: number | null } | null };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const short = (s: string, n = 4) => `${s.slice(0, n)}…${s.slice(-n)}`;
const usd = (v?: number | null) => v == null ? "—" : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1e3).toFixed(1)}k`;
const sol3 = (v?: number | null) => v == null ? "—" : v.toFixed(3);
const signed = (v?: number | null, d = 3) => v == null ? "—" : `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(d)}`;
const pnlClass = (v?: number | null) => v == null || Math.abs(v) < 0.0005 ? "flatc" : v > 0 ? "up" : "dn";
const SOL = "So11111111111111111111111111111111111111112";

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, error = false) {
  const t = $("toast"); t.textContent = text; t.className = `toast show${error ? " err" : ""}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = "toast"; }, 4000);
}

// ---------- source: local bridge ----------
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get("token")) localStorage.setItem("slrd.bridgeToken", hash.get("token")!);
if (hash.get("rpc")) localStorage.setItem("slrd.rpc", hash.get("rpc")!);
if (location.hash) history.replaceState(null, "", location.pathname); // never leave a token or key in the URL
const bridgeToken = localStorage.getItem("slrd.bridgeToken");
const api = async <T,>(path: string, body?: unknown): Promise<T> => {
  const r = await fetch(path, { method: body ? "POST" : "GET", headers: { "x-slrd-token": bridgeToken ?? "", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`); return j as T;
};

// ---------- source: browser only ----------
type LocalBot = { mint: string; buy: number; sell: number; steps: number; budgetSol: number };
const local = {
  get rpc() { return localStorage.getItem("slrd.rpc") ?? ""; },
  get bots(): LocalBot[] { try { return JSON.parse(localStorage.getItem("slrd.bots") ?? "[]"); } catch { return []; } },
  set bots(v: LocalBot[]) { localStorage.setItem("slrd.bots", JSON.stringify(v)); },
};
const liveLocal = new Map<string, { capUsd?: number; priceSol?: number; symbol?: string; trades: Trade[] }>();
let localSub: Awaited<ReturnType<typeof subscribeTrades>> | null = null;
async function loadSolUsd() {
  try { const j = await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL}`)).json() as Record<string, { usdPrice?: number }>; return Number(j[SOL]?.usdPrice) || null; } catch { return null; }
}
async function connectLocal() {
  await localSub?.close().catch(() => {});
  const bots = local.bots; if (!bots.length || !local.rpc) return;
  localSub = await subscribeTrades({
    source: "sqd", sqd: { portalUrl: "https://portal.sqd.dev/datasets/solana-mainnet" }, connection: new Connection(local.rpc, "confirmed"),
    tokens: bots.map(b => b.mint), venues: ["pump", "pumpswap", "raydium-launchlab", "raydium-cpmm", "meteora-dbc", "meteora-damm-v2"],
    solUsd: async () => (S.solUsd = (await loadSolUsd()) ?? S.solUsd) ?? 0, solUsdRefreshMs: 60_000,
    onTrade: (e: TradeEvent) => {
      const l = liveLocal.get(e.mint) ?? { trades: [] };
      const cap = e.market.marketCapSol != null && S.solUsd ? e.market.marketCapSol * S.solUsd : undefined;
      l.capUsd = cap ?? l.capUsd; l.priceSol = e.market.priceSol ?? l.priceSol; l.symbol = e.metadata?.symbol ?? l.symbol;
      const quote = e.quoteRaw == null ? null : Number(e.quoteRaw) / 10 ** e.market.quoteDecimals;
      l.trades.unshift({ signature: e.signature, atMs: e.atMs, side: e.side, sol: e.market.quoteMint === SOL ? quote : null, capUsd: cap ?? null, trader: e.trader ?? null });
      if (l.trades.length > 300) l.trades.length = 300;
      liveLocal.set(e.mint, l); schedule();
    },
  });
}
function localState(): State {
  const bots: Bot[] = local.bots.map(b => {
    const l = liveLocal.get(b.mint);
    let nextBuy: number | null = null, nextSell: number | null = null;
    if (l?.priceSol && l.capUsd) {
      const k = l.priceSol / l.capUsd;
      const p = targetPlan({ levels: rangeLevels(b.buy, b.sell, b.steps).map(c => c * k), budgetSol: b.budgetSol, balanceRaw: 0n, decimals: 6, priceSol: l.priceSol });
      nextBuy = p.nextBuy == null ? null : p.nextBuy / k; nextSell = p.nextSell == null ? null : p.nextSell / k;
    }
    return { wallet: "browser", mint: b.mint, symbol: l?.symbol, alive: true, capUsd: l?.capUsd ?? null, range: { unit: "usd", buy: b.buy, sell: b.sell },
      steps: b.steps, holdingSteps: 0, nextBuy, nextSell, costSol: 0, valueSol: 0, pnlSol: 0 };
  });
  return { wallets: [{ name: "browser", address: "", sol: null }], bots, solUsd: S.solUsd, daemon: null };
}

// ---------- app state ----------
const S = {
  mode: "browser" as "bridge" | "browser", solUsd: null as number | null, state: null as State | null,
  wallet: "all", mint: null as string | null, filter: "all" as "all" | "active" | "whale", query: "",
  trades: [] as Trade[],
};

async function refresh() {
  if (S.mode === "bridge") {
    try { S.state = await api<State>("/api/state"); S.solUsd = S.state.solUsd ?? S.solUsd; }
    catch (error) { toast(`bridge: ${error instanceof Error ? error.message : error}`, true); }
    if (S.mint) { try { S.trades = await api<Trade[]>(`/api/trades?mint=${S.mint}`); } catch {} }
  } else {
    S.state = localState();
    S.trades = S.mint ? liveLocal.get(S.mint)?.trades ?? [] : [];
  }
  render();
}
let pending = false;
function schedule() { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; void refresh(); }); } }

// ---------- views ----------
function visibleBots(): Bot[] {
  const q = S.query.trim().toLowerCase();
  return (S.state?.bots ?? []).filter(b => (S.wallet === "all" || b.wallet === S.wallet) &&
    (!q || b.mint.toLowerCase().includes(q) || (b.symbol ?? "").toLowerCase().includes(q)));
}
function nextOrder(b: Bot): { text: string; kind: string } {
  if (b.health) return { text: b.health.slice(0, 40), kind: "err" };
  if (b.pending) return { text: b.pending.slice(0, 40), kind: "buy" };
  const pct = (lvl: number) => b.capUsd ? ` (${lvl >= b.capUsd ? "+" : "−"}${Math.abs(Math.round((lvl / b.capUsd - 1) * 100))}%)` : "";
  const held = b.holdingSteps ?? 0, want = b.target ?? held;
  if (want > held && !b.paused) return /failed/i.test(b.last ?? "") ? { text: `buy now: ${(b.last ?? "").replace(/^S+ S+ buy failed /i, "").slice(0, 34)}`, kind: "err" } : { text: `buying → ${want}/${b.steps ?? 1}`, kind: "buy" };
  if (want < held) return { text: `selling → ${want}/${b.steps ?? 1}`, kind: "sell" };
  if (b.paused) return { text: "Buys paused", kind: "paused" };
  if ((b.holdingSteps ?? 0) > 0 && b.nextSell != null) return { text: `sell ${usd(b.nextSell)}${pct(b.nextSell)}`, kind: "sell" };
  if (b.nextBuy != null) return { text: `buy ${usd(b.nextBuy)}${pct(b.nextBuy)}`, kind: "buy" };
  return { text: "waiting", kind: "flat" };
}
const coinName = (b: Bot) => (b.auto ? "◆ " : "") + (b.symbol ?? short(b.mint));
const rangeText = (b: Bot) => !b.range ? "—" : b.range.unit === "usd"
  ? `${usd(b.range.buy)} → ${usd(b.range.sell)}${(b.steps ?? 1) > 1 ? ` ×${b.steps}` : ""}` : `${b.range.buy} → ${b.range.sell}`;

function render() {
  const st = S.state; if (!st) return;
  const running = st.bots.filter(b => b.alive).length;
  const daemonUp = S.mode === "browser" || !!st.daemon?.pid;
  $("chips").innerHTML = `<span class="chip">${S.mode === "bridge" ? `${st.wallets.length} wallets` : "browser only"}</span>
    <span class="chip ${daemonUp ? "live" : "warn"}"><span class="dot"></span>${running} bots running${daemonUp ? "" : " · daemon down"}</span>
    <span class="chip num" style="color:var(--text)">SOL ${S.solUsd ? "$" + S.solUsd.toFixed(2) : "—"}</span>`;

  // wallets: "all", then wallets with bots, then the rest
  const used = new Set(st.bots.map(b => b.wallet));
  const ws = [{ name: "all", sol: null as number | null }, ...st.wallets.filter(w => used.has(w.name)), ...st.wallets.filter(w => !used.has(w.name))];
  $("wallets").innerHTML = ws.map(w => `<button class="wallet${S.wallet === w.name ? " on" : ""}" data-w="${esc(w.name)}"><span>${esc(w.name)}${"address" in w && w.address ? copyCell(w.address, "", "span") : ""}</span><span class="num" style="color:var(--muted)">${w.sol == null ? "—" : w.sol.toFixed(3)}</span></button>`).join("");

  const bots = visibleBots();
  if (!S.mint || !bots.some(b => b.mint === S.mint)) S.mint = bots[0]?.mint ?? null;
  const total = bots.reduce((a, b) => a + (b.pnlSol ?? 0), 0);
  $("pos-sub").textContent = `${S.wallet === "all" ? "All wallets" : S.wallet} · ${bots.length} open`;
  $("total-pnl").innerHTML = `<span class="${pnlClass(total)}">${signed(total)} SOL</span>`;
  $("positions").querySelector("tbody")!.innerHTML = bots.length ? bots.map(b => {
    const steps = Math.max(1, b.steps ?? 1), held = b.holdingSteps ?? 0, o = nextOrder(b);
    const segs = Array.from({ length: steps }, (_, i) => `<span class="seg${i < held ? " on" : ""}"></span>`).join("");
    return `<tr class="row${b.mint === S.mint ? " on" : ""}" data-mint="${b.mint}">
      <td style="font-weight:600; white-space:nowrap">${esc(coinName(b))}${copyCell(b.mint)}</td><td style="color:var(--muted)">${esc(b.wallet)}</td>
      <td class="num r">${usd(b.capUsd)}</td><td class="num" style="color:var(--muted)">${esc(rangeText(b))}</td>
      <td class="num r">${sol3(b.costSol)}</td><td class="num r">${sol3(b.valueSol)}</td><td class="num r ${pnlClass(b.pnlSol)}">${signed(b.pnlSol)}</td>
      <td><div style="display:flex; align-items:center; gap:8px"><div style="display:flex; gap:3px">${segs}</div><span class="num" style="color:var(--muted)">${held}/${steps}</span></div></td>
      <td><span class="state ${o.kind}">${esc(o.text)}</span></td></tr>`;
  }).join("") : `<tr><td colspan="9" class="empty">${S.mode === "browser" && !local.rpc ? "Browser mode: press + New bot to set your RPC (e.g. a free Helius key) and add a coin." : "No bots. Press + New bot."}</td></tr>`;

  renderDetail(bots.find(b => b.mint === S.mint) ?? null);
  renderTrades();
}

function renderDetail(b: Bot | null) {
  const el = $("detail");
  if (!b) { el.innerHTML = `<div class="empty">Select a position.</div>`; return; }
  const o = nextOrder(b), bridge = S.mode === "bridge";
  el.innerHTML = `<div><div style="display:flex; align-items:baseline; gap:10px"><h2 style="font-size:22px; font-weight:700">${esc(coinName(b))}</h2><span class="state ${o.kind}">${esc(o.text)}</span></div>
      <div class="num" style="font-size:11px; margin-top:6px; word-break:break-all"><a href="https://dexscreener.com/solana/${b.mint}" target="_blank" rel="noreferrer" style="color:var(--dim)">${b.mint}</a>${copyCell(b.mint)} · <a href="./coin.html?mint=${b.mint}" style="font-weight:600">wallets &amp; live trades →</a></div></div>
    <div class="tiles">
      <div class="tile"><div class="k">Market cap</div><div class="v big num">${usd(b.capUsd)}</div></div>
      <div class="tile"><div class="k">PnL</div><div class="v big num ${pnlClass(b.pnlSol)}">${signed(b.pnlSol)} SOL</div></div>
      <div class="tile"><div class="k">Range</div><div class="v num">${esc(rangeText(b))}</div></div>
      <div class="tile"><div class="k">Wallet</div><div class="v num">${esc(b.wallet)}</div></div>
    </div>
    <div class="actions">
      <button class="primary" data-act="${b.paused ? "resume" : "pause"}" ${bridge ? "" : "disabled"}>${b.paused ? "Resume buys" : "Pause buys"}</button>
      <button data-act="range">Edit range</button>
      <button data-act="budget" ${bridge ? "" : "disabled"}>Size ${b.budgetSol != null ? b.budgetSol + " SOL" : ""}</button>
      <button data-act="relaunch" ${bridge && !b.alive ? "" : "disabled"}>Relaunch</button>
      <button class="danger" data-act="stop" ${bridge ? "" : "disabled"}>Sell all + stop</button>
    </div>
    <button class="linkbtn" data-act="remove">Remove bot…</button>
    ${b.last ? `<div class="num" style="color:var(--dim); font-size:11px">last: ${esc(b.last)}</div>` : ""}`;
}

function renderTrades() {
  const mine = new Set((S.state?.wallets ?? []).map(w => w.address).filter(Boolean));
  const stats = new Map<string, { b: number; s: number; net: number }>();
  for (const t of S.trades) if (t.trader) {
    const x = stats.get(t.trader) ?? { b: 0, s: 0, net: 0 };
    if (t.side === "buy") { x.b++; x.net -= t.sol ?? 0; } else if (t.side === "sell") { x.s++; x.net += t.sol ?? 0; }
    stats.set(t.trader, x);
  }
  const active = (tr: string | null) => !!tr && ((stats.get(tr)?.b ?? 0) + (stats.get(tr)?.s ?? 0)) >= 3;
  const rows = S.trades.filter(t => S.filter === "all" || (S.filter === "active" ? active(t.trader) : (t.sol ?? 0) >= 1)).slice(0, 200);
  const last = S.trades[0]?.atMs;
  $("trades-sub").textContent = S.mint ? `${S.trades.length} trades${last ? ` · last ${Math.max(0, Math.round((Date.now() - last) / 1000))}s ago` : ""}` : "";
  $("live").style.color = last && Date.now() - last < 120_000 ? "var(--up)" : "var(--dim)";
  $("trades").querySelector("tbody")!.innerHTML = rows.length ? rows.map(t => {
    const x = t.trader ? stats.get(t.trader) : undefined, big = (t.sol ?? 0) >= 1;
    return `<tr class="row"><td class="num" style="color:var(--dim)">${new Date(t.atMs).toLocaleTimeString([], { hour12: false })}</td>
      <td><span class="side ${t.side ?? ""}">${(t.side ?? "?").toUpperCase()}</span></td>
      <td class="num r" style="${big ? "font-weight:600; color:var(--text)" : "color:var(--muted)"}">${t.sol == null ? "—" : t.sol.toFixed(3)}</td>
      <td class="num r" style="color:var(--muted)">${usd(t.capUsd)}</td>
      <td>${t.trader ? `<a class="num" href="https://solscan.io/account/${t.trader}" target="_blank" rel="noreferrer" style="color:var(--text)">${short(t.trader)}</a>${copyCell(t.trader)}` : "—"}${t.trader && mine.has(t.trader) ? `<span class="tag mine">OURS</span>` : active(t.trader) ? `<span class="tag">ACTIVE</span>` : ""}</td>
      <td class="num" style="color:var(--muted)">${x ? `${x.b}/${x.s}` : "—"}</td>
      <td class="num r ${pnlClass(x?.net)}">${x ? signed(x.net, 2) : "—"}</td>
      <td class="num r"><a href="https://solscan.io/tx/${t.signature}" target="_blank" rel="noreferrer" style="color:var(--dim)">tx</a></td></tr>`;
  }).join("") : `<tr><td colspan="8" class="empty">${S.mint ? "Waiting for trades…" : "Select a position to see its trades."}</td></tr>`;
}

// ---------- actions ----------
const k = (s: string) => Number(s) * 1000; // ranges are typed in $k market cap
async function newBot() {
  if (S.mode === "browser" && !local.rpc) {
    const rpc = prompt("Your Solana RPC URL (e.g. a free Helius key). The public RPC does not allow browser apps.");
    if (!rpc) return; localStorage.setItem("slrd.rpc", rpc.trim());
  }
  const wallet = S.wallet === "all" ? (S.state?.bots[0]?.wallet ?? S.state?.wallets[0]?.name ?? "") : S.wallet;
  const input = prompt(`New bot:  MINT  BUY  SELL  [x3]  [SOL]   (range in $k market cap)${S.mode === "bridge" ? `\nwallet: ${wallet}` : ""}\ne.g.  Guv…pump 50 72 x3 0.05`);
  if (!input) return;
  const parts = input.trim().split(/\s+/);
  const mint = parts.find(p => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p));
  const nums = parts.filter(p => /^\d+(\.\d+)?$/.test(p));
  const steps = Number(parts.find(p => /^x\d+$/i.test(p))?.slice(1) ?? 3);
  if (!mint || nums.length < 2) { toast("Enter: MINT BUY SELL [x3] [SOL]", true); return; }
  const buy = k(nums[0]!), sell = k(nums[1]!), budget = Number(nums[2] ?? 0.05);
  if (S.mode === "bridge") {
    try { toast((await api<{ message: string }>("/api/bot", { action: "add", wallet, mint, buy, sell, steps, budget })).message); } catch (e) { toast(String(e instanceof Error ? e.message : e), true); }
  } else { local.bots = [...local.bots.filter(b => b.mint !== mint), { mint, buy, sell, steps, budgetSol: budget }]; await connectLocal(); }
  S.mint = mint; void refresh();
}
async function action(act: string) {
  const b = visibleBots().find(x => x.mint === S.mint); if (!b) return;
  const name = coinName(b);
  let body: Record<string, unknown> = { action: act, wallet: b.wallet, mint: b.mint };
  if (act === "range") {
    const cur = b.range ? `${b.range.buy / 1000} ${b.range.sell / 1000} ${b.steps ?? 1}` : "";
    const input = prompt(`Range for ${name}:  BUY SELL [STEPS]  in $k market cap`, cur); if (!input) return;
    const [buy, sell, steps] = input.trim().split(/\s+/).map(Number);
    if (!(buy! > 0 && sell! > buy!)) { toast("need BUY < SELL", true); return; }
    if (S.mode === "browser") { local.bots = local.bots.map(x => x.mint === b.mint ? { ...x, buy: buy! * 1000, sell: sell! * 1000, steps: steps || x.steps } : x); void refresh(); return; }
    body = { ...body, buy: buy! * 1000, sell: sell! * 1000, steps: steps || b.steps || 3 };
  }
  if (act === "budget") {
    const input = prompt(`Position size for ${name}: SOL when every step is filled (now ${b.budgetSol ?? "?"})`, String(b.budgetSol ?? "")); if (!input) return;
    const budget = Number(input.trim()); if (!(budget > 0 && budget <= 5)) { toast("size must be 0-5 SOL", true); return; }
    body = { ...body, budget };
  }
  if (act === "stop" && !confirm(`Sell ALL ${name} in ${b.wallet} and stop the bot?`)) return;
  if (act === "remove") {
    if (!confirm(`Remove the ${name} bot? The position stays in the wallet.`)) return;
    if (S.mode === "browser") { local.bots = local.bots.filter(x => x.mint !== b.mint); await connectLocal(); void refresh(); return; }
  }
  try { toast((await api<{ message: string }>("/api/bot", body)).message); } catch (e) { toast(String(e instanceof Error ? e.message : e), true); }
  void refresh();
}

function wire() {
  $("wallets").onclick = e => { const w = (e.target as HTMLElement).closest("[data-w]")?.getAttribute("data-w"); if (w) { S.wallet = w; render(); } };
  $("positions").onclick = e => { const m = (e.target as HTMLElement).closest("[data-mint]")?.getAttribute("data-mint"); if (m && m !== S.mint) { S.mint = m; S.trades = []; void refresh(); } };
  $("filters").onclick = e => {
    const f = (e.target as HTMLElement).getAttribute("data-f") as typeof S.filter | null; if (!f) return;
    S.filter = f; for (const b of $("filters").querySelectorAll("button")) b.classList.toggle("on", b.getAttribute("data-f") === f); renderTrades();
  };
  $("detail").onclick = e => { const a = (e.target as HTMLElement).closest("[data-act]")?.getAttribute("data-act"); if (a) void action(a); };
  $("new").onclick = () => void newBot();
  $<HTMLInputElement>("search").oninput = e => { S.query = (e.target as HTMLInputElement).value; render(); };
}

async function start() {
  installCopy(); wire();
  if (bridgeToken) { try { await api("/api/state"); S.mode = "bridge"; } catch { S.mode = "browser"; } }
  if (S.mode === "browser") { S.solUsd = await loadSolUsd(); await connectLocal().catch(e => toast(`stream: ${e}`, true)); }
  await refresh();
  setInterval(() => void refresh(), S.mode === "bridge" ? 1_500 : 2_000);
}
void start();
