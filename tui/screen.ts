/** Pure model + renderer for slrd-tui. No I/O here except reading bot/range files in scanBots. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type WalletRow = { name: string; address: string; sol: number | null };
export type BotRow = {
  wallet: string; mint: string; alive: boolean; pid: number | null;
  phase: "buy" | "sell"; health: string | null; paused: string | null;
  amountRaw: string | null; costSol: number | null; pending: string | null;
  capUsd: number | null; capAgeMs: number | null; priceSol: number | null;
  range: { unit: "usd" | "sol"; buy: number; sell: number } | null;
  updatedAt: number;
  /** Bid-ask steps in the range (1 = plain range bot) and how many are holding. */
  steps?: number; holdingSteps?: number;
  /** Steps: lowest sell level among holding steps, highest buy level among flat steps (USD mcap or SOL price). */
  nextSell?: number | null; nextBuy?: number | null;
  /** Target mode: holdings are the wallet's whole balance; `target` is the step count it is trading toward. */
  mode?: "target"; target?: number | null; budgetSol?: number; last?: string | null; valueSol?: number | null;
  /** Opened by the migration watcher. */
  auto?: boolean;
};
export type TradeRow = {
  signature: string; atMs: number; side: "buy" | "sell" | null; sol: number | null;
  tokens: number | null; capUsd: number | null; trader: string | null; creator: string | null;
};
export type CoinWallets = { mint: string; walletCount: number; holders: number; wallets: Array<{ trader: string; held: number; pct: number; buys: number; sells: number;
  solIn: number; solOut: number; pnlSol: number; lastAtMs: number; delta5: { tokens: number } | null; smart: unknown; ours: string | null; dev: boolean }> };
export type TraderStats = { buys: number; sells: number; netSol: number; firstSeen: number; balanceSol?: number | null };

const json = (path: string) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Bots worth showing: running, holding, or with a pending transaction. One row per wallet+mint;
 * bid-ask step slices (bot-<w>-<m>.sN.json) are summed into that row. */
export function scanBots(root: string, now = Date.now()): BotRow[] {
  const dir = join(root, ".range-bots");
  if (!existsSync(dir)) return [];
  const groups = new Map<string, { wallet: string; mint: string; parts: { id: string; path: string; state: any; alive: boolean; pid: number | null }[] }>();
  for (const name of readdirSync(dir)) {
    const match = /^bot-([^-]+)-([1-9A-HJ-NP-Za-km-z]{32,44})(?:\.(s\d+))?\.json$/.exec(name);
    if (!match) continue;
    const [, wallet, mint, slice] = match as unknown as [string, string, string, string | undefined];
    const path = join(dir, name), state = json(path);
    if (!state) continue;
    const lock = join(root, `bot-${wallet}-${mint}${slice ? `.${slice}` : ""}.json.lock`);
    const pid = existsSync(lock) ? Number(readFileSync(lock, "utf8").trim()) : null;
    const alive = pid != null && Number.isInteger(pid) && pidAlive(pid);
    const k = `${wallet}:${mint}`;
    if (!groups.has(k)) groups.set(k, { wallet, mint, parts: [] });
    groups.get(k)!.parts.push({ id: slice ?? "main", path, state, alive, pid: alive ? pid : null });
  }
  const rows: BotRow[] = [];
  for (const { wallet, mint, parts: all } of groups.values()) {
    // When slices run, a leftover flat "main" (or vice versa) is history, not a live part.
    const live = all.filter(p => p.alive || p.state.position || p.state.pending);
    if (!live.length) continue;
    const parent = json(join(root, "ranges", `${wallet}-${mint}.json`));
    const r = parent ?? live[0]!.state.rangeSpec ?? null;
    const range = r?.buyMarketCapUsd != null ? { unit: "usd" as const, buy: Number(r.buyMarketCapUsd), sell: Number(r.sellMarketCapUsd) }
      : r?.buyPriceSol != null ? { unit: "sol" as const, buy: Number(r.buyPriceSol), sell: Number(r.sellPriceSol) } : null;
    const holding = live.filter(p => p.state.position);
    // Each step's own levels come from its rung file (ranges/<w>-<m>.sN.json).
    const levels = (p: { id: string }) => {
      const r = p.id === "main" ? parent : json(join(root, "ranges", `${wallet}-${mint}.${p.id}.json`));
      return r?.buyMarketCapUsd != null ? { buy: Number(r.buyMarketCapUsd), sell: Number(r.sellMarketCapUsd) }
        : r?.buyPriceSol != null ? { buy: Number(r.buyPriceSol), sell: Number(r.sellPriceSol) } : null;
    };
    const sells = holding.map(levels).filter(Boolean).map(l => l!.sell);
    const buys = live.filter(p => !p.state.position && !p.state.pending && !p.state.entryPause).map(levels).filter(Boolean).map(l => l!.buy);
    const newest = [...live].sort((a, b) => (b.state.marketObservation?.at ?? 0) - (a.state.marketObservation?.at ?? 0))[0]!;
    const last = Array.isArray(newest.state.prices) ? newest.state.prices.at(-1) : null;
    const slices = live.filter(p => p.id !== "main").length;
    const pendingPart = live.find(p => p.state.pending);
    rows.push({
      wallet, mint, alive: live.some(p => p.alive), pid: live.find(p => p.alive)?.pid ?? null,
      phase: holding.length ? "sell" : "buy", health: newest.state.health ?? null,
      paused: live.find(p => p.state.entryPause)?.state.entryPause.reason ?? null,
      amountRaw: holding.length ? holding.reduce((sum, p) => sum + BigInt(p.state.position.amountRaw), 0n).toString() : null,
      costSol: holding.length ? holding.reduce((sum, p) => sum + Number(p.state.position.costLamports) / 1e9, 0) : null,
      pending: pendingPart?.state.pending.side ?? null,
      capUsd: newest.state.marketObservation?.capUsd ?? null,
      capAgeMs: newest.state.marketObservation ? now - newest.state.marketObservation.at : null,
      priceSol: typeof last?.price === "number" ? last.price : null,
      range, updatedAt: Math.max(...live.map(p => statSync(p.path).mtimeMs)),
      steps: Number.isInteger(parent?.steps) ? parent.steps : Math.max(1, slices), holdingSteps: holding.length,
      nextSell: sells.length ? Math.min(...sells) : null, nextBuy: buys.length ? Math.max(...buys) : null,
    });
  }
  // Target-mode bots (slrd-bots): one status file per coin; replaces any engine row for that coin.
  for (const name of readdirSync(dir)) {
    const match = /^target-([^-]+)-([1-9A-HJ-NP-Za-km-z]{32,44})\.json$/.exec(name);
    if (!match) continue;
    const t = json(join(dir, name));
    if (!t || now - t.updatedAt > 60_000) continue;
    const [, wallet, mint] = match as unknown as [string, string, string];
    const i = rows.findIndex(r => r.wallet === wallet && r.mint === mint);
    if (i >= 0) rows.splice(i, 1);
    const scale = 10 ** (t.decimals ?? 6);
    rows.push({
      wallet, mint, alive: now - t.updatedAt < 15_000, pid: null, phase: (t.held ?? 0) > 0 ? "sell" : "buy",
      health: t.error, paused: t.buysPaused ? "BUYS PAUSED" : null,
      amountRaw: t.balanceRaw && t.balanceRaw !== "0" ? t.balanceRaw : null, costSol: typeof t.flowSol === "number" ? -t.flowSol : null, pending: t.inFlight,
      capUsd: t.capUsd, capAgeMs: now - t.updatedAt, priceSol: t.priceSol,
      range: { unit: t.range.unit, buy: t.range.buy, sell: t.range.sell }, updatedAt: t.updatedAt,
      steps: t.range.steps, holdingSteps: t.held ?? 0, nextSell: t.nextSell, nextBuy: t.nextBuy,
      mode: "target", target: t.target, budgetSol: t.budgetSol, last: t.last,
      valueSol: t.balanceRaw && t.priceSol ? Number(t.balanceRaw) / scale * t.priceSol : null,
    });
  }
  const registry = ((json(join(dir, "bots.json"))?.bots ?? []) as Array<{ wallet?: string; mint: string; auto?: boolean }>);
  const auto = new Set<string>(registry.filter(b => b.auto).map(b => b.mint));
  for (const r of rows) if (auto.has(r.mint)) r.auto = true;
  // Fixed order = the order bots were added (registry order), newest on top. Never sort by
  // live state (alive, mtime, P&L): those flip every second and made rows jump around.
  const order = new Map(registry.map((b, i) => [b.mint, i]));
  return rows.sort((a, b) => (order.get(b.mint) ?? -1) - (order.get(a.mint) ?? -1) || a.wallet.localeCompare(b.wallet) || a.mint.localeCompare(b.mint));
}

/** Session stats per trader, built from the stream itself. */
export function recordTrade(stats: Map<string, TraderStats>, trade: TradeRow) {
  if (!trade.trader) return;
  const s = stats.get(trade.trader) ?? { buys: 0, sells: 0, netSol: 0, firstSeen: trade.atMs };
  if (trade.side === "buy") { s.buys++; s.netSol -= trade.sol ?? 0; }
  if (trade.side === "sell") { s.sells++; s.netSol += trade.sol ?? 0; }
  stats.set(trade.trader, s);
}

// ---- rendering ----
const ESC = "\u001b[";
const color = (code: number, text: string) => `${ESC}${code}m${text}${ESC}0m`;
export const c = { dim: (t: string) => color(2, t), bold: (t: string) => color(1, t), green: (t: string) => color(32, t),
  red: (t: string) => color(31, t), yellow: (t: string) => color(33, t), cyan: (t: string) => color(36, t),
  magenta: (t: string) => color(35, t), inverse: (t: string) => color(7, t) };
const visible = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
/** Pad/truncate by visible width, keeping ANSI codes intact. */
export function fit(text: string, width: number): string {
  const plain = visible(text);
  if (plain.length <= width) return text + " ".repeat(width - plain.length);
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}
export const usd = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? "--"
  : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`;
export const sol = (v: number | null | undefined, digits = 3) => v == null || !Number.isFinite(v) ? "--" : v.toFixed(digits);
export const short = (address: string | null | undefined, n = 4) => !address ? "?" : `${address.slice(0, n)}…${address.slice(-n)}`;
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });

export type Screen = {
  width: number; height: number; focus: "wallets" | "bots";
  wallets: WalletRow[]; walletIndex: number;   // 0 = all
  bots: BotRow[]; botIndex: number;
  symbols: Map<string, string>;
  trades: TradeRow[]; traders: Map<string, TraderStats>;
  mine: Map<string, string>;                   // address -> our wallet name
  streamStatus: string; solUsd: number | null;
  prompt: { label: string; text: string } | null; message: string;
  tradeOffset?: number;                        // 0 = live (newest at top)
  /** Bottom panel: live trades (default) or every wallet in the coin (key w). */
  bottom?: "trades" | "wallets";
  coinWallets?: CoinWallets | null;
};
/** Rows of the trade list that fit on screen. */
export function tradeRows(s: Pick<Screen, "height">) { return Math.max(1, Math.max(20, s.height) - 2 - 3 - 3 - Math.max(6, Math.min(14, Math.floor((Math.max(20, s.height) - 4) * 0.4))) - 1); }

export function filteredBots(s: Pick<Screen, "bots" | "wallets" | "walletIndex">): BotRow[] {
  const w = s.walletIndex > 0 ? s.wallets[s.walletIndex - 1]?.name : null;
  return w ? s.bots.filter(b => b.wallet === w) : s.bots;
}

function botState(b: BotRow): string {
  if (b.mode === "target") {
    if (!b.alive) return c.red("STOPPED");
    if (b.pending) return c.yellow(`TRADING: ${b.pending}`);
    const steps = b.steps ?? 1, fmt = (v: number) => b.range?.unit === "usd" ? usd(v) : v.toPrecision(3);
    const dist = (v: number) => b.capUsd && b.range?.unit === "usd" ? ` (${v >= b.capUsd ? "+" : "−"}${Math.abs((v / b.capUsd - 1) * 100).toFixed(0)}%)` : "";
    const held = b.holdingSteps ?? 0, want = b.target ?? held;
    // Behind target: it wants to trade right now (say why it has not, e.g. not enough SOL), not where it would sell later.
    if (want !== held && !(want > held && b.paused)) {
      const why = b.last && /failed/i.test(b.last) ? c.red(` · failing: ${b.last.replace(/^S+ S+ (buy|sell) failed /i, "").slice(0, 50)}`) : "";
      return `${(held ? c.green : c.cyan)(`${held}/${steps}`)}${c.yellow(` → ${want}`)} · ${want > held ? "BUY now" : "SELL now"}${why}`;
    }
    const parts = [held > 0 && b.nextSell != null ? `sell ${fmt(b.nextSell)}${dist(b.nextSell)}` : null,
      b.nextBuy != null && !b.paused ? `buy ${fmt(b.nextBuy)}${dist(b.nextBuy)}` : null].filter(Boolean).join(" · ");
    const gap = b.target != null && b.target !== b.holdingSteps ? c.yellow(` → ${b.target}`) : "";
    const head = (b.holdingSteps ? c.green : c.cyan)(`${b.holdingSteps ?? 0}/${steps}`) + gap;
    return `${head}${b.paused ? c.yellow(" buys paused") : ""}${parts ? ` · ${parts}` : ""}${b.health ? c.red(` ! ${b.health.slice(0, 40)}`) : ""}`;
  }
  if (!b.alive) return c.red(b.pending ? `STOPPED · ${b.pending.toUpperCase()} PENDING` : "STOPPED");
  if (b.pending) return c.yellow(`${b.pending.toUpperCase()} PENDING`);
  if (b.paused) return c.yellow(`PAUSED ${b.paused}`);
  const steps = b.steps ?? 1;
  // Where the next action happens and how far the market cap has to move to get there.
  const target = b.range && b.range.unit === "usd" ? (b.phase === "sell" ? b.range.sell : b.range.buy) : null;
  const away = target != null && b.capUsd ? ` (${target >= b.capUsd ? "+" : "−"}${Math.abs((target / b.capUsd - 1) * 100).toFixed(0)}%)` : "";
  const next = target != null ? ` · ${b.phase === "sell" ? "sell" : "buy"} ${usd(target)}${away}` : "";
  if (steps > 1) {
    const fmt = (v: number) => b.range?.unit === "usd" ? usd(v) : v.toPrecision(3);
    const dist = (v: number) => b.capUsd && b.range?.unit === "usd" ? ` (${v >= b.capUsd ? "+" : "−"}${Math.abs((v / b.capUsd - 1) * 100).toFixed(0)}%)` : "";
    const parts = [b.nextSell != null ? `sell ${fmt(b.nextSell)}${dist(b.nextSell)}` : null,
      b.nextBuy != null ? `buy ${fmt(b.nextBuy)}${dist(b.nextBuy)}` : null].filter(Boolean).join(" · ");
    const head = b.holdingSteps ? c.green(`HOLD ${b.holdingSteps}/${steps}`) : c.cyan(`WAIT 0/${steps}`);
    return parts ? `${head} · ${parts}` : head;
  }
  return b.phase === "sell" ? c.green(`HOLDING${next}`) : c.cyan(`WAIT BUY${next}`);
}
function rangeText(b: BotRow) {
  if (!b.range) return "--";
  const steps = (b.steps ?? 1) > 1 ? ` ×${b.steps}` : "";
  return (b.range.unit === "usd" ? `${usd(b.range.buy)} → ${usd(b.range.sell)}` : `${b.range.buy.toPrecision(3)} → ${b.range.sell.toPrecision(3)}`) + steps;
}
/** Position value from the bot's last sampled price; pump tokens use 6 decimals. */
export function positionValueSol(b: BotRow): number | null {
  if (b.mode === "target") return b.valueSol ?? null;
  if (!b.amountRaw || b.priceSol == null) return null;
  return Number(b.amountRaw) / 1e6 * b.priceSol;
}

export function render(s: Screen): string {
  const W = Math.max(80, s.width), H = Math.max(20, s.height);
  const leftW = 26, rightW = W - leftW - 1;
  const out: string[] = [];
  const bots = filteredBots(s);
  const sel = bots[s.botIndex] ?? null;
  out.push(c.inverse(fit(` SOLARD  ${s.wallets.length} wallets · ${s.bots.filter(b => b.alive).length} bots running · SOL ${s.solUsd ? "$" + s.solUsd.toFixed(2) : "--"}`, W)));
  out.push(c.dim(fit(" h/l pane  j/k select  v discovery  w wallets/trades  c copy CA  e range  s size  n new  r resume  PgUp/PgDn trades  x x sell+stop  o relaunch  d d remove  q quit", W)));

  // Top block: wallets (left) | positions (right)
  const topH = Math.max(6, Math.min(14, Math.floor((H - 4) * 0.4)));
  const left: string[] = [c.bold(s.focus === "wallets" ? "▸ WALLETS" : "  WALLETS")];
  const walletItems = [{ name: "all", sol: null as number | null }, ...s.wallets];
  walletItems.slice(0, topH - 1).forEach((w, i) => {
    const line = ` ${fit(w.name, 12)} ${w.name === "all" ? "" : sol(w.sol, 3).padStart(9)}`;
    left.push(i === s.walletIndex ? (s.focus === "wallets" ? c.inverse(fit(line, leftW)) : c.bold(line)) : line);
  });
  const right: string[] = [c.bold(s.focus === "bots" ? "▸ POSITIONS / BOTS" : "  POSITIONS / BOTS")];
  right.push(c.dim(` ${fit("WALLET", 7)} ${fit("COIN", 10)} ${fit("MCAP", 9)} ${fit("RANGE", 18)} ${fit("COST", 7)} ${fit("VALUE", 7)} ${fit("PNL", 8)} STATE`));
  const start = Math.max(0, s.botIndex - (topH - 3));
  bots.slice(start, start + topH - 2).forEach((b, i) => {
    const value = positionValueSol(b), pnl = value != null && b.costSol != null ? value - b.costSol : null;
    const stale = b.capAgeMs == null || b.capAgeMs > 15_000;
    const pnlText = pnl == null ? "--" : (pnl >= 0 ? c.green : c.red)((pnl >= 0 ? "+" : "") + pnl.toFixed(3));
    const line = ` ${fit(b.wallet, 7)} ${fit((b.auto ? "◆" : "") + (s.symbols.get(b.mint) ?? short(b.mint)), 10)} ${fit(usd(b.capUsd) + (stale ? "?" : ""), 9)} ${fit(rangeText(b), 18)} ${fit(sol(b.costSol), 7)} ${fit(sol(value), 7)} ${fit(pnlText, 8)} ${botState(b)}`;
    right.push(start + i === s.botIndex ? (s.focus === "bots" ? c.inverse(fit(visible(line), rightW)) : c.bold(fit(line, rightW))) : line);
  });
  if (!bots.length) right.push(c.dim("  No bots. Press n to start one: <MINT> <BUY> <SELL>"));
  for (let i = 0; i < topH; i++) out.push(fit(left[i] ?? "", leftW) + "│" + fit(right[i] ?? "", rightW));
  out.push("─".repeat(W));

  // Bottom block: selected position + live trades
  const bottomH = H - out.length - 2;
  if (sel) {
    const name = s.symbols.get(sel.mint) ?? short(sel.mint);
    const value = positionValueSol(sel);
    out.push(fit(` ${c.bold(name)} ${c.dim(sel.mint)}  ${sel.wallet}  mcap ${c.bold(usd(sel.capUsd))}  range ${c.bold(rangeText(sel))}  ${botState(sel)}`, W));
    out.push(fit(` ${sel.amountRaw ? `holding ${(Number(sel.amountRaw) / 1e6).toLocaleString()} tokens · cost ${sol(sel.costSol)} · value ${sol(value)} SOL` : "flat"}   ${c.dim("trades: " + s.streamStatus)}${(s.tradeOffset ?? 0) > 0 ? c.yellow(`  SCROLLED ${s.tradeOffset} back · End = live`) : ""}`, W));
    out.push(c.dim(fit(` ${fit("TIME", 8)} ${fit("SIDE", 4)} ${fit("SOL", 8)} ${fit("MCAP", 8)} ${fit("TRADER", 11)} ${fit("TAG", 6)} ${fit("SESSION b/s", 11)} ${fit("NET SOL", 8)} WALLET SOL`, W)));
    if (s.bottom === "wallets") {
      const cw = s.coinWallets?.mint === sel.mint ? s.coinWallets : null;
      out.pop(); // trades header
      out.push(c.dim(fit(` ${fit("WALLET", 12)} ${fit("TAG", 7)} ${fit("HOLDS", 7)} ${fit("%SUP", 6)} ${fit("5 MIN", 9)} ${fit("IN SOL", 7)} ${fit("OUT SOL", 7)} ${fit("P&L", 7)} ${fit("B/S", 7)} LAST   ${cw ? `${cw.walletCount} wallets · ${cw.holders} holding` : "loading… (needs slrd-bridge)"}`, W)));
      const tok = (v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : v.toFixed(0);
      const list = (cw?.wallets ?? []).filter(w => w.held > 0).slice(s.tradeOffset ?? 0, (s.tradeOffset ?? 0) + Math.max(0, bottomH - 3));
      for (const w of list) {
        const tag = w.ours ? c.magenta(w.ours.slice(0, 7)) : w.dev ? c.yellow("DEV") : w.smart ? c.yellow("★ smart") : "";
        const d = w.delta5 ? (w.delta5.tokens >= 0 ? c.green(`▲ ${tok(w.delta5.tokens)}`) : c.red(`▼ ${tok(-w.delta5.tokens)}`)) : "";
        const pnl = (w.pnlSol >= 0 ? c.green : c.red)((w.pnlSol >= 0 ? "+" : "") + w.pnlSol.toFixed(2));
        const ago = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(0)}h`;
        out.push(fit(` ${fit(short(w.trader, 5), 12)} ${fit(tag, 7)} ${fit(tok(w.held), 7)} ${fit(w.pct.toFixed(2), 6)} ${fit(d, 9)} ${fit(w.solIn.toFixed(2), 7)} ${fit(w.solOut.toFixed(2), 7)} ${fit(pnl, 7)} ${fit(`${w.buys}/${w.sells}`, 7)} ${ago(Date.now() - w.lastAtMs)}`, W));
      }
      if (!list.length) out.push(c.dim(cw ? "  no holders recorded yet" : "  loading wallets…"));
      while (out.length < H - 1) out.push("");
      out.length = H - 1;
      out.push(s.prompt ? c.bold(fit(` ${s.prompt.label}: ${s.prompt.text}█`, W)) : fit(s.message ? ` ${s.message}` : "", W));
      return out.join("\n");
    }
    const offset = Math.max(0, Math.min(s.tradeOffset ?? 0, Math.max(0, s.trades.length - 1)));
    const rows = s.trades.slice(offset, offset + Math.max(0, bottomH - 3));
    for (const t of rows) {
      const st = t.trader ? s.traders.get(t.trader) : undefined;
      const tag = t.trader && s.mine.has(t.trader) ? c.magenta(s.mine.get(t.trader)!.slice(0, 6))
        : t.trader && t.trader === t.creator ? c.yellow("DEV") : st && st.buys + st.sells >= 5 ? c.cyan("ACTIVE") : "";
      const side = t.side === "buy" ? c.green("BUY ") : t.side === "sell" ? c.red("SELL") : "?   ";
      const net = st ? (st.netSol >= 0 ? c.green : c.red)((st.netSol >= 0 ? "+" : "") + st.netSol.toFixed(2)) : "";
      out.push(fit(` ${fit(clock(t.atMs), 8)} ${side} ${fit(sol(t.sol), 8)} ${fit(usd(t.capUsd), 8)} ${fit(short(t.trader), 11)} ${fit(tag, 6)} ${fit(st ? `${st.buys}/${st.sells}` : "", 11)} ${fit(net, 8)} ${st?.balanceSol == null ? c.dim("…") : sol(st.balanceSol, 2)}`, W));
    }
    if (!rows.length) out.push(c.dim("  waiting for trades…"));
  } else out.push(c.dim(" Select a position to see its range and live trades."));
  while (out.length < H - 1) out.push("");
  out.length = H - 1;
  out.push(s.prompt ? c.bold(fit(` ${s.prompt.label}: ${s.prompt.text}█`, W)) : fit(s.message ? ` ${s.message}` : "", W));
  return out.join("\n");
}

// ---------- Discovery view (key v): live coins, bonding curve | migrated, side by side ----------
export type DiscoveryCoin = { mint: string; symbol: string | null; ageMs: number | null; capUsd: number | null; ammCapUsd?: number | null;
  trades: number; lastTradeMs: number; migrated: boolean; status: string; smart?: number };
export type DiscoveryDecision = { atMs: number; mint: string; name: string; symbol?: string | null; decision: string; reason: string };
export type DiscoveryData = { at: number; firehose: { liveCoins: number; perSec: number; lagMs: number } | null; coins: DiscoveryCoin[]; decisions: DiscoveryDecision[] };
const ago = (ms: number | null) => ms == null ? "--" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`;
export function renderDiscovery(s: Pick<Screen, "width" | "height" | "prompt" | "message">, d: DiscoveryData | null, now = Date.now()): string {
  const W = Math.max(80, s.width), H = Math.max(20, s.height), out: string[] = [];
  const f = d?.firehose;
  out.push(c.inverse(fit(` SOLARD DISCOVERY  ${f ? `${f.liveCoins} live coins · ${f.perSec.toFixed(0)} trades/s · lag ${(f.lagMs / 1000).toFixed(1)}s` : "firehose off"}${d ? ` · updated ${ago(now - d.at)} ago` : ""}`, W)));
  out.push(c.dim(fit(" v back to positions  q quit   ★ = followable wallets bought   coins drop off 10 min after their last trade", W)));
  const colW = Math.floor((W - 1) / 2), decH = Math.max(5, Math.min(12, Math.floor((H - 4) * 0.3))), listH = H - 4 - decH - 1;
  const col = (title: string, coins: DiscoveryCoin[]) => {
    const rows = [c.bold(` ${title} (${coins.length})`), c.dim(` ${fit("COIN", 11)} ${fit("AGE", 5)} ${fit("MCAP", 8)} ${fit("TRADES", 6)} ${fit("★", 2)} ${fit("LAST", 4)}`)];
    for (const x of coins.slice(0, listH - 2)) {
      const name = (x.status === "ours" ? "◆" : "") + (x.symbol ?? short(x.mint));
      const line = ` ${fit(name, 11)} ${fit(ago(x.ageMs), 5)} ${fit(usd(x.migrated ? x.ammCapUsd ?? x.capUsd : x.capUsd), 8)} ${fit(String(x.trades), 6)} ${fit(x.smart ? String(x.smart) : "", 2)} ${fit(ago(now - x.lastTradeMs), 4)}`;
      rows.push(x.smart ? c.yellow(line) : x.status === "ours" ? c.green(line) : line);
    }
    while (rows.length < listH) rows.push("");
    return rows.map(r => fit(r, colW));
  };
  const coins = d?.coins ?? [];
  const a = col("NEW · BONDING CURVE", coins.filter(x => !x.migrated)), b = col("MIGRATED", coins.filter(x => x.migrated));
  for (let i = 0; i < listH; i++) out.push(`${a[i]}${c.dim("│")}${b[i]}`);
  out.push(c.bold(" DECISIONS (migration + smart wallets)"));
  for (const x of (d?.decisions ?? []).slice(0, decH)) {
    const tag = x.decision === "opened" || x.decision === "buys-on" ? c.green(fit(x.decision, 8)) : x.decision === "skipped" ? c.yellow(fit(x.decision, 8)) : c.red(fit(x.decision, 8));
    out.push(fit(` ${fit(clock(x.atMs), 8)} ${fit(x.symbol ?? x.name, 10)} ${tag} ${x.reason}`, W));
  }
  while (out.length < H - 1) out.push("");
  out.length = H - 1;
  out.push(s.prompt ? c.bold(fit(` ${s.prompt.label}: ${s.prompt.text}█`, W)) : fit(s.message ? ` ${s.message}` : "", W));
  return out.join("\n");
}
