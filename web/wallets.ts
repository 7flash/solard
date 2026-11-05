/** Wallet explorer: who trades how. Leaderboard (P&L, win rate, how early), wallet profile, the coin trade
 * map (every trade as a dot over market cap and time, the selected wallet highlighted), and co-traders.
 * Data from the local bridge (scores from the firehose-fed traderStats, recent trades from the daemon). */
import { $, esc, short, usd, ago, api, copyCell, installCopy } from "./common.ts";
import { drawTradeMap, hitDot, dotTip, type Dot } from "./trade-map.ts";
const signed = (v?: number | null, d = 2) => v == null || !Number.isFinite(v) ? "—" : `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(d)}`;
const cls = (v?: number | null) => v == null || Math.abs(v) < 0.005 ? "flatc" : v > 0 ? "up" : "dn";
type Score = { trader: string; pnlSol: number; realizedSol: number; openSol: number; coins: number; wins: number; trades: number; solIn: number; avgRankPct: number; earlyCoins: number; lastAtMs: number;
  medEntryCap: number | null; medExitCap: number | null; medMultiple: number | null; medHoldMin: number | null };
type CoinRow = { mint: string; symbol: string | null; buys: number; sells: number; solIn: number; solOut: number; openSol: number; pnlSol: number; heldTokens: number; rank: number | null; buyers: number; firstAtMs: number; lastAtMs: number; entryCapUsd?: number | null; exitCapUsd?: number | null };
type WalletInfo = { wallet: string; score: Score | null; coins: CoinRow[]; coTraders: Array<{ trader: string; shared: number; score: Score | null }> };
type Trade = { signature: string; atMs: number; side: "buy" | "sell" | null; sol: number | null; capUsd: number | null; trader: string | null };

const S = { sort: "pnl", min: 3, wallet: null as string | null, info: null as WalletInfo | null, mint: null as string | null, trades: [] as Trade[], symbol: null as string | null };

async function loadBoard() {
  const d = await api<{ wallets: number; at: number; rows: Score[] }>(`/api/wallets?sort=${S.sort}&minCoins=${S.min}`);
  $("summary").textContent = `${d.wallets.toLocaleString()} wallets scored · updated ${ago(Date.now() - d.at)} ago`;
  $("board").querySelector("tbody")!.innerHTML = d.rows.map(s => `<tr class="row${s.trader === S.wallet ? " on" : ""}" data-w="${s.trader}">
    <td class="num">${short(s.trader)}${copyCell(s.trader)}</td><td class="num r ${cls(s.pnlSol)}">${signed(s.pnlSol)}</td><td class="num r">${s.coins}</td>
    <td class="num r">${Math.round(s.wins / s.coins * 100)}%</td><td class="num r">${Number.isFinite(s.avgRankPct) ? `top ${Math.round(s.avgRankPct)}%` : "—"}</td>
    <td class="num r">${usd(s.medEntryCap)}</td><td class="num r">${usd(s.medExitCap)}</td><td class="num r ${s.medMultiple == null ? "" : s.medMultiple >= 1 ? "up" : "dn"}">${s.medMultiple == null ? "—" : s.medMultiple.toFixed(1) + "×"}</td>
    <td class="num r">${s.medHoldMin == null ? "—" : s.medHoldMin < 1 ? "<1m" : Math.round(s.medHoldMin) + "m"}</td><td class="num r dim">${ago(Date.now() - s.lastAtMs)}</td></tr>`).join("") || `<tr><td colspan="10" class="empty">No wallets yet with ${S.min}+ coins.</td></tr>`;
}

async function selectWallet(addr: string) {
  S.wallet = addr; history.replaceState(null, "", `?addr=${addr}`); S.info = await api<WalletInfo>(`/api/wallet?addr=${addr}`);
  const s = S.info.score;
  $("w-title").innerHTML = `<span class="num">${addr}</span>${copyCell(addr)}`;
  $("w-link").innerHTML = `<a href="https://solscan.io/account/${addr}" target="_blank" rel="noreferrer">Solscan</a> · <a href="https://gmgn.ai/sol/address/${addr}" target="_blank" rel="noreferrer">GMGN</a>`;
  $("tiles").innerHTML = !s ? `<div class="empty">No trades recorded for this wallet.</div>` : [
    ["P&L", `<span class="${cls(s.pnlSol)}">${signed(s.pnlSol, 3)} SOL</span>`], ["Realized", `<span class="${cls(s.realizedSol)}">${signed(s.realizedSol, 3)}</span>`],
    ["Still holding", `${s.openSol.toFixed(3)} SOL`], ["Win rate", `${Math.round(s.wins / s.coins * 100)}% of ${s.coins} coins`],
    ["Entry rank", Number.isFinite(s.avgRankPct) ? `top ${Math.round(s.avgRankPct)}% of buyers` : "—"], ["Median entry → exit", `${usd(s.medEntryCap)} → ${usd(s.medExitCap)}${s.medMultiple ? ` (${s.medMultiple.toFixed(1)}×)` : ""}`],
    ["Median hold", s.medHoldMin == null ? "—" : `${s.medHoldMin < 1 ? "<1" : Math.round(s.medHoldMin)} min`], ["Early entries", `${s.earlyCoins} coins (first 10%)`], ["Trades", String(s.trades)],
  ].map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v num">${v}</div></div>`).join("");
  $("coins").querySelector("tbody")!.innerHTML = S.info.coins.map(c => `<tr class="row${c.mint === S.mint ? " on" : ""}" data-m="${c.mint}">
    <td><b>${esc(c.symbol ?? short(c.mint))}</b>${copyCell(c.mint)}<a class="ext" href="https://dexscreener.com/solana/${c.mint}" target="_blank" rel="noreferrer" title="chart">↗</a>${c.heldTokens > 0 && c.openSol > 0.001 ? `<span class="tag hold">HOLDS</span>` : ""}</td>
    <td class="num r">${c.buys}/${c.sells}</td><td class="num r">${c.solIn.toFixed(2)}</td><td class="num r">${c.solOut.toFixed(2)}</td><td class="num r">${c.openSol.toFixed(2)}</td>
    <td class="num r ${cls(c.pnlSol)}">${signed(c.pnlSol)}</td><td class="num r">${c.rank == null ? "—" : `#${c.rank + 1}/${c.buyers}`}</td><td class="num r">${usd(c.entryCapUsd)}</td><td class="num r">${usd(c.exitCapUsd)}</td><td class="num r dim">${ago(Date.now() - c.lastAtMs)}</td></tr>`).join("");
  $("co").querySelector("tbody")!.innerHTML = S.info.coTraders.map(c => `<tr class="row" data-w="${c.trader}"><td class="num">${short(c.trader)}${copyCell(c.trader)}</td><td class="num r">${c.shared}</td>
    <td class="num r ${cls(c.score?.pnlSol)}">${signed(c.score?.pnlSol)}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">No wallet shares 2+ coins with this one.</td></tr>`;
  for (const tr of $("board").querySelectorAll("tr[data-w]")) tr.classList.toggle("on", tr.getAttribute("data-w") === addr);
  if (!S.mint && S.info.coins[0]) await selectCoin(S.info.coins[0].mint); else draw();
}

async function selectCoin(mint: string) {
  S.mint = mint; if (S.wallet) history.replaceState(null, "", `?addr=${S.wallet}&mint=${mint}`);
  const d = await api<{ coin: { recent: Trade[]; capUsd: number | null; trades: number } | null; symbol: string | null }>(`/api/coin?mint=${mint}`);
  S.trades = d.coin?.recent ?? []; S.symbol = d.symbol;
  $("m-title").innerHTML = `Coin trade map · ${esc(S.symbol ?? short(mint))}${copyCell(mint)}`;
  $("m-sub").innerHTML = d.coin ? `${S.trades.length} recent trades · ${usd(d.coin.capUsd)} · <a href="https://dexscreener.com/solana/${mint}" target="_blank" rel="noreferrer">chart</a>` : "not live in the firehose (dead or older than this session)";
  for (const tr of $("coins").querySelectorAll("tr[data-m]")) tr.classList.toggle("on", tr.getAttribute("data-m") === mint);
  draw();
}

// ---------- trade map (web/trade-map.ts) ----------
let dots: Dot[] = [];
function draw() { dots = drawTradeMap($<HTMLCanvasElement>("map"), S.trades, S.wallet, S.mint ? "No recent trades for this coin in the firehose." : "Select a wallet, then a coin."); }

function wire() {
  $("sort").onclick = e => { const s = (e.target as HTMLElement).getAttribute("data-s"); if (!s) return; S.sort = s; for (const b of $("sort").querySelectorAll("button")) b.classList.toggle("on", b.getAttribute("data-s") === s); void loadBoard(); };
  $<HTMLSelectElement>("min").onchange = e => { S.min = Number((e.target as HTMLSelectElement).value); void loadBoard(); };
  const pickWallet = (e: Event) => { const w = (e.target as HTMLElement).closest("[data-w]")?.getAttribute("data-w"); if (w) { S.mint = null; void selectWallet(w); } };
  $("board").onclick = pickWallet; $("co").onclick = pickWallet;
  $("coins").onclick = e => { const m = (e.target as HTMLElement).closest("[data-m]")?.getAttribute("data-m"); if (m) void selectCoin(m); };
  $<HTMLInputElement>("search").onkeydown = async e => {
    const v = (e.target as HTMLInputElement).value.trim(); if (e.key !== "Enter" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return;
    if (v.endsWith("pump") || !(await api<WalletInfo>(`/api/wallet?addr=${v}`)).score) await selectCoin(v); else { S.mint = null; await selectWallet(v); }
  };
  const c = $<HTMLCanvasElement>("map"), tip = $("tip");
  c.onmousemove = e => {
    const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const d = [...dots].reverse().find(d => (d.x - x) ** 2 + (d.y - y) ** 2 <= (d.r + 3) ** 2);
    if (!d) { tip.style.display = "none"; return; }
    tip.style.display = "block"; tip.style.left = `${e.clientX + 12}px`; tip.style.top = `${e.clientY + 12}px`;
    tip.innerHTML = dotTip(d, "click to select wallet");
  };
  c.onmouseleave = () => { tip.style.display = "none"; };
  c.onclick = e => {
    const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const d = [...dots].reverse().find(d => (d.x - x) ** 2 + (d.y - y) ** 2 <= (d.r + 3) ** 2);
    if (d?.t.trader) { const keep = S.mint; void selectWallet(d.t.trader).then(() => { if (keep) void selectCoin(keep); }); }
  };
  addEventListener("resize", draw);
}

installCopy(); wire(); void loadBoard(); setInterval(() => void loadBoard(), 60_000);
{
  const q = new URLSearchParams(location.search), addr = q.get("addr") ?? (location.hash.length > 30 ? location.hash.slice(1) : null), mint = q.get("mint");
  if (addr) void selectWallet(addr).then(() => { if (mint) void selectCoin(mint); });
  else if (mint) void selectCoin(mint);
}
setInterval(() => { if (S.mint) void selectCoin(S.mint); }, 10_000);
