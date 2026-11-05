/** Discovery: every coin the firehose is watching, bonding curve and migrated side by side (a coin drops
 * off 10 min after its last trade), how many followable wallets bought each one, and every entry decision.
 * Data from the local bridge (/api/discovery, written by the daemon every 5s). */
import { $, esc, short, usd, ago, api, copyCell, installCopy } from "./common.ts";

type Coin = { mint: string; symbol: string | null; ageMs: number | null; capUsd: number | null; ammCapUsd?: number | null; trades: number; traders?: number;
  smart?: number; lastTradeMs: number; status: string; reason: string | null; migrated: boolean };
type Decision = { atMs: number; mint: string; name: string; decision: string; reason: string; symbol?: string | null; capUsd?: number | null };
type Disc = { firehose: { liveCoins: number; perSec: number; lagMs: number } | null; coins: Coin[]; decisions: Decision[] };

const S = { dec: "all", q: "" };
const coinCell = (mint: string, symbol?: string | null) =>
  `<a href="./coin.html?mint=${mint}" style="color:var(--text); font-weight:600" title="wallets and live trades">${esc(symbol || short(mint))}</a>${copyCell(mint)} <a href="https://dexscreener.com/solana/${mint}" target="_blank" rel="noreferrer" style="color:var(--dim)">↗</a>`;
const chip = (s: string) => s === "ours" ? "sell" : s === "rejected" ? "err" : s === "migrated" ? "buy" : "flat";
const isSmart = (d: Decision) => d.reason.startsWith("smart");

function coinRows(list: Coin[]) {
  return list.map(c => `<tr class="row${c.smart ? " smart" : ""}">
      <td>${coinCell(c.mint, c.symbol)}</td>
      <td class="num r" style="color:var(--muted)">${c.ageMs == null ? "—" : ago(c.ageMs)}</td>
      <td class="num r">${usd(c.migrated ? c.ammCapUsd ?? c.capUsd : c.capUsd)}</td>
      <td class="num r">${c.trades.toLocaleString()}</td><td class="num r" style="color:var(--muted)">${c.traders ?? "—"}</td>
      <td class="num r star">${c.smart ? `★${c.smart}` : ""}</td>
      <td class="num r" style="color:var(--dim)">${ago(Date.now() - c.lastTradeMs)}</td>
      <td><span class="state ${chip(c.status)}" title="${esc(c.reason ?? "")}">${esc(c.status)}</span></td></tr>`).join("")
    || `<tr><td colspan="8" class="empty">No matching coins traded in the last 10 min.</td></tr>`;
}

async function refresh() {
  let d: Disc;
  try { d = await api<Disc>("/api/discovery"); }
  catch (error) { $("fh").textContent = `bridge unreachable: ${error instanceof Error ? error.message : error}`; return; }
  const f = d.firehose;
  $("fh").textContent = f ? `${f.liveCoins.toLocaleString()} live coins · ${f.perSec.toFixed(0)} trades/s · lag ${(f.lagMs / 1000).toFixed(1)}s` : "firehose off";
  const q = S.q.toLowerCase(), match = (mint: string, sym?: string | null) => !q || mint.toLowerCase().includes(q) || (sym ?? "").toLowerCase().includes(q);

  const coins = d.coins.filter(c => match(c.mint, c.symbol));
  const fresh = coins.filter(c => !c.migrated), migrated = coins.filter(c => c.migrated);
  $("new-sub").textContent = `${fresh.length}`; $("mig-sub").textContent = `${migrated.length}`;
  $("new").querySelector("tbody")!.innerHTML = coinRows(fresh);
  $("mig").querySelector("tbody")!.innerHTML = coinRows(migrated);

  const opened = (x: Decision) => x.decision === "opened" || x.decision === "buys-on";
  const dk = (x: string) => x === "opened" || x === "buys-on" ? "sell" : x === "skipped" ? "paused" : "err";
  const decs = d.decisions.filter(x => match(x.mint, x.symbol ?? x.name) &&
    (S.dec === "all" || (S.dec === "opened" ? opened(x) : S.dec === "smart" ? isSmart(x) : !opened(x))));
  $("dec-sub").textContent = ` · ${d.decisions.filter(opened).length} opened of ${d.decisions.length} · ${d.decisions.filter(isSmart).length} smart-wallet`;
  $("decisions").querySelector("tbody")!.innerHTML = decs.map(x => `<tr class="row${isSmart(x) ? " smart" : ""}">
      <td class="num" style="color:var(--dim)" title="${new Date(x.atMs).toLocaleString()}">${new Date(x.atMs).toLocaleTimeString([], { hour12: false })}</td>
      <td>${coinCell(x.mint, x.symbol ?? x.name)}</td><td class="num r">${usd(x.capUsd)}</td>
      <td><span class="state ${dk(x.decision)}">${esc(x.decision)}</span></td><td style="color:var(--muted)">${esc(x.reason)}</td></tr>`).join("")
    || `<tr><td colspan="5" class="empty">No decisions since the daemon started.</td></tr>`;
}

$("dec-filters").addEventListener("click", e => {
  const b = (e.target as HTMLElement).closest("button"); if (!b) return;
  S.dec = b.dataset.f!; for (const x of $("dec-filters").querySelectorAll("button")) x.classList.toggle("on", x === b); void refresh();
});
$("search").addEventListener("input", e => { S.q = (e.target as HTMLInputElement).value.trim(); void refresh(); });
installCopy();
void refresh(); setInterval(() => void refresh(), 5_000);
