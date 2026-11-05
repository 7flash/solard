/** One coin: every wallet in it (net holding from all trades the firehose has seen, % of supply, what it put in
 * and took out, change over the last 5 minutes) and the live trade feed. Followable wallets are tagged ★,
 * the creator DEV, our wallets by name. Rows flash green/red when a wallet grows or shrinks. Refreshes every 2s. */
import { $, esc, short, usd, ago, api, copyCell, installCopy } from "./common.ts";
import { drawTradeMap, hitDot, dotTip, type Dot } from "./trade-map.ts";

type Wallet = { trader: string; held: number; pct: number; buys: number; sells: number; solIn: number; solOut: number; pnlSol: number;
  firstAtMs: number; lastAtMs: number; entryCapUsd: number | null; delta5: { tokens: number; sol: number; last: string; at: number } | null;
  smart: { realizedSol: number; winRate: number; coins: number } | null; ours: string | null; dev: boolean };
type Trade = { signature: string; atMs: number; side: string; sol: number | null; tokens: number | null; capUsd: number | null; trader: string | null; smart: boolean; ours: string | null };
type Coin = { mint: string; symbol: string | null; capUsd: number | null; migrated: boolean | null; launchedAtMs: number | null; trades: number;
  creator: string | null; priceSol: number | null; wallets: Wallet[]; walletCount: number; holders: number; recent: Trade[] };

const params = new URLSearchParams(location.search);
const S = { mint: params.get("mint") ?? "", sort: "held", holders: true, hover: null as string | null, pin: null as string | null, trades: [] as Trade[] };
const sol = (v: number, d = 2) => (v >= 0 ? "" : "−") + Math.abs(v).toFixed(d);
const signed = (v: number, d = 2) => `<span class="${v >= 0 ? "up" : "dn"}">${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}</span>`;
const tokens = (v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0);
const tags = (w: { trader: string | null; smart?: unknown; ours?: string | null; dev?: boolean }, creator: string | null) =>
  (w.smart ? `<span class="tag smart" title="followable wallet">★</span>` : "") + (w.dev || (creator && w.trader === creator) ? `<span class="tag dev">DEV</span>` : "") + (w.ours ? `<span class="tag ours">${esc(w.ours)}</span>` : "");
const walletLink = (a: string) => `<a class="num" href="./wallets.html?addr=${a}&mint=${S.mint}" title="open this wallet (with this coin on its trade map)">${short(a, 5)}</a>${copyCell(a)}`;
let lastHeld = new Map<string, number>();

async function refresh() {
  if (!S.mint) { $("title").textContent = "Paste a mint above"; return; }
  let d: Coin;
  try { d = await api<Coin>(`/api/coin-wallets?mint=${S.mint}`); }
  catch (error) { $("title").textContent = `error: ${error instanceof Error ? error.message : error}`; return; }
  document.title = `${d.symbol ?? short(d.mint)} · SOLARD`;
  $("title").innerHTML = `${esc(d.symbol ?? short(d.mint))}${copyCell(d.mint, "CA")}`;
  $("links").innerHTML = `<a href="https://dexscreener.com/solana/${d.mint}" target="_blank" rel="noreferrer">DexScreener ↗</a> · <a href="https://gmgn.ai/sol/token/${d.mint}" target="_blank" rel="noreferrer">GMGN ↗</a> · <a href="https://solscan.io/token/${d.mint}" target="_blank" rel="noreferrer">Solscan ↗</a>`;
  const smartIn = d.wallets.filter(w => w.smart && w.held > 0).length, top10 = d.wallets.slice(0, 10).reduce((a, w) => a + w.pct, 0);
  const stat = (k: string, v: string) => `<div class="stat"><div class="k">${k}</div><div class="v num">${v}</div></div>`;
  $("stats").innerHTML = stat("MCAP", usd(d.capUsd)) + stat("STAGE", d.migrated ? "migrated" : d.migrated === false ? "bonding curve" : "—")
    + stat("AGE", d.launchedAtMs ? ago(Date.now() - d.launchedAtMs) : "—") + stat("TRADES SEEN", d.trades.toLocaleString())
    + stat("WALLETS", `${d.walletCount.toLocaleString()} · ${d.holders.toLocaleString()} holding`) + stat("TOP 10 HOLD", `${top10.toFixed(1)}%`)
    + stat("★ FOLLOWABLE HOLDING", String(smartIn));

  const key: Record<string, (w: Wallet) => number> = { held: w => w.held, delta: w => Math.abs(w.delta5?.tokens ?? 0), pnl: w => w.pnlSol, recent: w => w.lastAtMs };
  const list = d.wallets.filter(w => !S.holders || w.held > 0).sort((a, b) => key[S.sort]!(b) - key[S.sort]!(a));
  const maxPct = Math.max(0.0001, ...list.map(w => w.pct));
  $("w-sub").textContent = `${list.length} shown`;
  const held = new Map(d.wallets.map(w => [w.trader, w.held]));
  $("wallets").querySelector("tbody")!.innerHTML = list.slice(0, 300).map(w => {
    const before = lastHeld.get(w.trader), flash = before == null || before === w.held ? "" : w.held > before ? " flash" : " flashdn";
    const dl = w.delta5 ? `<span class="${w.delta5.tokens >= 0 ? "up" : "dn"}">${w.delta5.tokens >= 0 ? "▲" : "▼"} ${tokens(Math.abs(w.delta5.tokens))}</span>` : "";
    return `<tr class="row${flash}" data-w="${w.trader}"><td>${walletLink(w.trader)}${tags(w, d.creator)}</td>
      <td class="num r">${tokens(w.held)}</td><td class="num r">${w.pct.toFixed(2)}%</td>
      <td><div class="barbox"><div class="bar" style="width:${Math.max(1, w.pct / maxPct * 90)}px"></div></div></td>
      <td class="num r">${dl}</td><td class="num r">${sol(w.solIn)}</td><td class="num r">${sol(w.solOut)}</td><td class="num r">${signed(w.pnlSol)}</td>
      <td class="num r" style="color:var(--muted)">${w.buys}/${w.sells}</td><td class="num r" style="color:var(--muted)">${usd(w.entryCapUsd)}</td>
      <td class="num r" style="color:var(--dim)">${ago(Date.now() - w.lastAtMs)}</td></tr>`;
  }).join("") || `<tr><td colspan="11" class="empty">No wallet data for this coin yet (the firehose records trades from when the daemon sees them).</td></tr>`;
  lastHeld = held;

  S.trades = d.recent;
  $("trades").querySelector("tbody")!.innerHTML = d.recent.map(t => `<tr class="row"${t.trader ? ` data-w="${t.trader}"` : ""}>
      <td class="num" style="color:var(--dim)">${new Date(t.atMs).toLocaleTimeString([], { hour12: false })}</td>
      <td><span class="${t.side === "buy" ? "up" : "dn"}" style="font-weight:600">${t.side.toUpperCase()}</span></td>
      <td class="num r">${t.sol == null ? "—" : t.sol.toFixed(3)}</td><td class="num r">${usd(t.capUsd)}</td>
      <td>${t.trader ? walletLink(t.trader) + tags(t, d.creator) : "—"}</td>
      <td class="num r" style="color:var(--muted)">${t.trader && held.has(t.trader) ? tokens(held.get(t.trader)!) : "—"}</td></tr>`).join("")
    || `<tr><td colspan="6" class="empty">No live trades in memory (coin not active in the last minutes).</td></tr>`;
  highlight();
}

$("mint").addEventListener("keydown", e => {
  if ((e as KeyboardEvent).key !== "Enter") return;
  const v = ($("mint") as HTMLInputElement).value.trim(); if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return;
  S.mint = v; lastHeld = new Map(); history.replaceState(null, "", `?mint=${v}`); void refresh();
});
$("sort").addEventListener("click", e => {
  const b = (e.target as HTMLElement).closest("button"); if (!b) return;
  S.sort = b.dataset.f!; for (const x of $("sort").querySelectorAll("button")) x.classList.toggle("on", x === b); void refresh();
});
$("holders").addEventListener("change", e => { S.holders = (e.target as HTMLInputElement).checked; void refresh(); });
installCopy();
void refresh(); setInterval(() => void refresh(), 2_000);

// ---------- linking: hover a trade or a wallet -> both tables and the map highlight that wallet ----------
let dots: Dot[] = [];
function highlight(scroll = false) {
  const w = S.hover ?? S.pin;
  for (const tr of document.querySelectorAll<HTMLElement>("#wallets tr[data-w], #trades tr[data-w]")) tr.classList.toggle("hl", !!w && tr.dataset.w === w);
  if (scroll && w) document.querySelector<HTMLElement>(`#wallets tr[data-w="${w}"]`)?.scrollIntoView({ block: "nearest" });
  $("pin").textContent = S.pin ? `pinned ${short(S.pin, 5)} · click empty space to clear` : "";
  dots = drawTradeMap($<HTMLCanvasElement>("map"), [...S.trades].reverse() as never, w, "No live trades for this coin in memory.");
}
const hoverFrom = (scroll: boolean) => (e: Event) => {
  const w = (e.target as HTMLElement).closest<HTMLElement>("tr[data-w]")?.dataset.w ?? null;
  if (w !== S.hover) { S.hover = w; highlight(scroll); }
};
$("trades").addEventListener("mouseover", hoverFrom(true));
$("wallets").addEventListener("mouseover", hoverFrom(false));
for (const id of ["trades", "wallets"]) $(id).addEventListener("mouseleave", () => { S.hover = null; highlight(); });
{
  const c = $<HTMLCanvasElement>("map"), tip = $("tip");
  c.addEventListener("mousemove", e => {
    const d = hitDot(dots, c, e);
    if (!d) { tip.style.display = "none"; if (S.hover) { S.hover = null; highlight(); } return; }
    tip.style.display = "block"; tip.style.left = `${e.clientX + 12}px`; tip.style.top = `${e.clientY + 12}px`; tip.innerHTML = dotTip(d, "click to pin this wallet");
    if (d.t.trader && d.t.trader !== S.hover) { S.hover = d.t.trader; highlight(true); }
  });
  c.addEventListener("mouseleave", () => { tip.style.display = "none"; S.hover = null; highlight(); });
  c.addEventListener("click", e => { const d = hitDot(dots, c, e); S.pin = d?.t.trader ?? null; highlight(true); });
  addEventListener("resize", () => highlight());
}
