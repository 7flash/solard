/** 1-minute candles for the coins we run, built from the firehose trades the daemon already receives (no requests).
 * Saved to .range-bots/candles.json so they survive restarts. */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Candle = { m: number; o: number; h: number; l: number; c: number; v: number };
const KEEP_MIN = 12 * 60;

export class Candles {
  private readonly byMint = new Map<string, Candle[]>();
  private readonly path: string;
  constructor(root: string) {
    this.path = resolve(root, ".range-bots", "candles.json");
    try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Candle[]>)) this.byMint.set(k, v); } catch {}
    setInterval(() => this.flush(), 60_000).unref?.();
  }
  add(mint: string, atMs: number, capUsd: number | null | undefined, sol: number | null | undefined) {
    if (!capUsd || !(capUsd > 0)) return;
    const m = Math.floor(atMs / 60_000), list = this.byMint.get(mint) ?? this.byMint.set(mint, []).get(mint)!, last = list[list.length - 1];
    if (last?.m === m) { last.h = Math.max(last.h, capUsd); last.l = Math.min(last.l, capUsd); last.c = capUsd; last.v += sol ?? 0; }
    else if (!last || m > last.m) { list.push({ m, o: capUsd, h: capUsd, l: capUsd, c: capUsd, v: sol ?? 0 }); if (list.length > KEEP_MIN) list.splice(0, list.length - KEEP_MIN); }
  }
  /** The range the chart drew: split the last hour into 3% price bins, count the separate minutes each bin was touched,
   * keep bins touched at least minTouches times. Bottom and top of those are the band: a wick touched once does not
   * count, a price it kept returning to does. Null with under `minCandles` of history. */
  band(mint: string, minutes = 60, minCandles = 30, now = Date.now(), minTouches = 3) {
    const from = Math.floor(now / 60_000) - minutes, xs = (this.byMint.get(mint) ?? []).filter(c => c.m >= from);
    if (xs.length < minCandles) return null;
    const step = Math.log(1.03), bin = (v: number) => Math.floor(Math.log(v) / step), touches = new Map<number, number>();
    for (const c of xs) for (let b = bin(c.l); b <= bin(c.h); b++) touches.set(b, (touches.get(b) ?? 0) + 1);
    const kept = [...touches].filter(([, n]) => n >= minTouches).map(([b]) => b).sort((x, y) => x - y);
    if (!kept.length) return null;
    return { lo: Math.exp(kept[0]! * step), hi: Math.exp((kept[kept.length - 1]! + 1) * step), candles: xs.length };
  }
  private flush() { try { writeFileSync(`${this.path}.tmp`, JSON.stringify(Object.fromEntries(this.byMint))); renameSync(`${this.path}.tmp`, this.path); } catch {} }
}
