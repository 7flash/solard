/** Coin trade map (shared by the Wallets and Coin pages): every trade as a dot over time (x) and market cap
 * (log y), green buys / red sells sized by SOL, the price path behind them, and one wallet's trades drawn on
 * top with a dashed path. Returns the dots for hit testing (tooltips, clicks). */
import { short, usd } from "./common.ts";
import { axisWithRange, capAt, liveCandles, mapSpan, rangeLines, type MapCandle, type MapFill, type MapHistory, type MapRange } from "./trade-map-math.ts";

export type MapTrade = { signature?: string; atMs: number; side: "buy" | "sell" | string | null; sol: number | null; capUsd: number | null; trader: string | null };
export type Dot = { x: number; y: number; r: number; t: MapTrade };
export type { MapCandle, MapFill, MapHistory, MapRange };

export function drawTradeMap(c: HTMLCanvasElement, trades: MapTrade[], highlight: string | null, empty: string, history: MapHistory = {}): Dot[] {
  const dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr; c.height = H * dpr; const g = c.getContext("2d")!; g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  const ts = trades.filter(t => t.capUsd && t.capUsd > 0 && t.atMs);
  const dots: Dot[] = [], candles = liveCandles((history.candles ?? []).filter(k => k.h > 0 && k.l > 0), ts);
  if (!ts.length && !candles.length) { g.fillStyle = "#8A94A3"; g.font = "13px Inter"; g.fillText(empty, 16, 28); return dots; }
  const pad = { l: 64, r: 62, t: 14, b: 26 };
  const span = mapSpan(ts, candles), { t0 } = span, t1 = span.t1 + 60_000, { lo, hi } = axisWithRange(span.lo, span.hi, history.range), edge = Math.max(0.01, (Math.log10(hi) - Math.log10(lo)) * 0.06), c0 = Math.log10(lo) - edge, c1 = Math.log10(hi) + edge;
  const X = (t: number) => pad.l + (t - t0) / (t1 - t0) * (W - pad.l - pad.r), Y = (cap: number) => pad.t + (1 - (Math.log10(cap) - c0) / (c1 - c0)) * (H - pad.t - pad.b);
  g.strokeStyle = "#1F252D"; g.fillStyle = "#8A94A3"; g.font = "11px 'JetBrains Mono'"; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const v = 10 ** (c0 + (c1 - c0) * i / 4), y = Y(v); g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke(); g.fillText(usd(v), 6, y + 4); }
  const long = t1 - t0 > 20 * 3_600_000;
  for (let i = 0; i <= 4; i++) { const t = t0 + (t1 - t0) * i / 4, d = new Date(t); g.fillText(`${long ? `${d.getDate()}/${d.getMonth() + 1} ` : ""}${d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" })}`, X(t) - 18, H - 8); }
  // The position's range: shaded band, a line at every step, top and bottom labelled.
  if (history.range) {
    const r = history.range, inView = (v: number) => Y(v) >= pad.t - 1 && Y(v) <= H - pad.b + 1, top = Math.max(pad.t, Y(r.sell)), bottom = Math.min(H - pad.b, Y(r.buy));
    if (bottom > top) { g.fillStyle = "rgba(143,168,255,.07)"; g.fillRect(pad.l, top, W - pad.l - pad.r, bottom - top); }
    g.strokeStyle = "rgba(143,168,255,.35)"; g.setLineDash([3, 4]);
    for (const v of rangeLines(r)) if (inView(v)) { g.beginPath(); g.moveTo(pad.l, Y(v)); g.lineTo(W - pad.r, Y(v)); g.stroke(); }
    g.setLineDash([]); g.fillStyle = "#8FA8FF";
    if (inView(r.sell)) g.fillText(`sell ${usd(r.sell)}`, W - pad.r + 4, Y(r.sell) + 4);
    if (inView(r.buy)) g.fillText(`buy ${usd(r.buy)}`, W - pad.r + 4, Y(r.buy) + 4);
  }
  // Candles: the whole time we have tracked the coin. Long histories join minutes so every candle stays readable.
  if (candles.length) {
    const plotW = W - pad.l - pad.r, per = Math.max(1, Math.ceil(candles.length / (plotW / 5))), joined: Required<MapCandle>[] = [];
    for (const k of candles) {
      const m = Math.floor(k.m / per) * per, last = joined[joined.length - 1], o = k.o ?? k.c;
      if (last?.m === m) { last.h = Math.max(last.h, k.h); last.l = Math.min(last.l, k.l); last.c = k.c; } else joined.push({ m, o, h: k.h, l: k.l, c: k.c });
    }
    const w = Math.max(2, Math.min(14, plotW / ((t1 - t0) / (per * 60_000)) * 0.7));
    for (const k of joined) {
      const x = X((k.m + per / 2) * 60_000), up = k.c >= k.o; g.strokeStyle = g.fillStyle = up ? "#3DD68C" : "#FF7A66"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, Y(k.h)); g.lineTo(x, Y(k.l)); g.stroke();
      const a = Y(Math.max(k.o, k.c)), b = Y(Math.min(k.o, k.c)); g.fillRect(x - w / 2, a, w, Math.max(1, b - a));
    }
    // Where the price is now.
    const now = candles[candles.length - 1]!.c, y = Y(now);
    g.strokeStyle = "#E6E8EB"; g.lineWidth = 1; g.setLineDash([1, 3]); g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke(); g.setLineDash([]);
    g.fillStyle = "#E6E8EB"; g.fillText(usd(now), W - pad.r + 4, y + 4);
  }
  const sorted = [...ts].sort((a, b) => a.atMs - b.atMs);
  if (!candles.length) { g.strokeStyle = "#2A313B"; g.beginPath(); sorted.forEach((t, i) => i ? g.lineTo(X(t.atMs), Y(t.capUsd!)) : g.moveTo(X(t.atMs), Y(t.capUsd!))); g.stroke(); }
  const mine = highlight ? sorted.filter(t => t.trader === highlight) : [];
  for (const t of candles.length ? [] : sorted) {
    if (highlight && t.trader === highlight) continue;
    const r = Math.max(2, Math.min(9, Math.sqrt(t.sol ?? 0) * 6)), x = X(t.atMs), y = Y(t.capUsd!);
    g.fillStyle = t.side === "buy" ? (highlight ? "rgba(61,214,140,.3)" : "rgba(61,214,140,.55)") : (highlight ? "rgba(255,122,102,.3)" : "rgba(255,122,102,.55)");
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); dots.push({ x, y, r, t });
  }
  if (mine.length) {
    g.strokeStyle = "#8FA8FF"; g.lineWidth = 1.5; g.setLineDash([4, 4]); g.beginPath();
    mine.forEach((t, i) => i ? g.lineTo(X(t.atMs), Y(t.capUsd!)) : g.moveTo(X(t.atMs), Y(t.capUsd!))); g.stroke(); g.setLineDash([]);
    for (const t of mine) {
      const r = Math.max(5, Math.min(12, Math.sqrt(t.sol ?? 0) * 7)), x = X(t.atMs), y = Y(t.capUsd!);
      g.fillStyle = t.side === "buy" ? "#3DD68C" : "#FF7A66"; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "#FFFFFF"; g.lineWidth = 2; g.stroke(); dots.push({ x, y, r, t });
    }
  }
  // Our own fills go on top, so they stay visible long after the trades around them have left memory.
  for (const f of history.fills ?? []) {
    const cap = capAt(f.atMs, candles, ts); if (!cap || f.atMs < t0 || f.atMs > t1) continue;
    const x = X(f.atMs), y = Y(cap), r = 8;
    g.fillStyle = f.side === "buy" ? "#3DD68C" : "#FF7A66"; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#FFFFFF"; g.lineWidth = 2; g.stroke();
    g.fillStyle = "#0B0E11"; g.font = "bold 10px Inter"; g.fillText(f.side === "buy" ? "B" : "S", x - 3.5, y + 3.5); g.font = "11px 'JetBrains Mono'";
    dots.push({ x, y, r, t: { atMs: f.atMs, side: f.side, sol: f.sol, capUsd: cap, trader: null } });
  }
  return dots;
}

export const hitDot = (dots: Dot[], c: HTMLCanvasElement, e: MouseEvent) => {
  const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  return [...dots].reverse().find(d => (d.x - x) ** 2 + (d.y - y) ** 2 <= (d.r + 3) ** 2) ?? null;
};
export const dotTip = (d: Dot, hint: string) =>
  `${d.t.side?.toUpperCase()} ${(d.t.sol ?? 0).toFixed(3)} SOL · ${usd(d.t.capUsd)}<br>${d.t.trader ? short(d.t.trader, 6) : "?"} · ${new Date(d.t.atMs).toLocaleTimeString([], { hour12: false })}<br><span style="color:#8A94A3">${hint}</span>`;
