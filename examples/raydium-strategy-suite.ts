#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type Flags = Map<string, string>;
type Trade = {
  signature: string;
  slot: number;
  tradedAtMs: number;
  side: "buy" | "sell";
  tokenDeltaUi: number;
  solDeltaUi: number;
  priceSol: number;
};
type Fill = {
  atMs: number;
  side: "buy" | "sell";
  price: number;
  sol: number;
  tokens: number;
  reason: string;
};
type Result = {
  name: string;
  finalEquity: number;
  returnPct: number;
  maxDrawdownPct: number;
  realizedSol: number;
  tokenAmount: number;
  cashSol: number;
  capitalInjectedSol: number;
  turnoverSol: number;
  fills: Fill[];
};
function parseArgs(a: string[]): Flags {
  const m = new Map<string, string>();
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (!v.startsWith("--")) continue;
    const [k, x] = v.slice(2).split("=", 2);
    if (x != null) m.set(k!, x);
    else if (a[i + 1] && !a[i + 1]!.startsWith("--")) m.set(k!, a[++i]!);
    else m.set(k!, "true");
  }
  return m;
}
function flag(f: Flags, k: string) {
  const v = f.get(k);
  return v && v !== "true" ? v : undefined;
}
function req(f: Flags, k: string) {
  const v = flag(f, k);
  if (!v) throw new Error(`Missing --${k}`);
  return v;
}
function num(f: Flags, k: string, d: number) {
  const r = flag(f, k),
    n = r == null ? d : Number(r);
  if (!Number.isFinite(n)) throw new Error(`Invalid --${k}`);
  return n;
}
function load(path: string): Trade[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((x) => JSON.parse(x))
    .filter((x: Trade) => Number.isFinite(x.priceSol) && x.priceSol > 0)
    .sort((a, b) => a.tradedAtMs - b.tradedAtMs || a.slot - b.slot);
}
function feePrice(price: number, side: "buy" | "sell", costBps: number) {
  const f = costBps / 10000;
  return side === "buy" ? price * (1 + f) : price * (1 - f);
}
function drawdown(equities: number[]) {
  let peak = 0,
    max = 0;
  for (const e of equities) {
    peak = Math.max(peak, e);
    if (peak > 0) max = Math.max(max, (peak - e) / peak);
  }
  return max * 100;
}
function finalize(
  name: string,
  start: number,
  cash: number,
  tokens: number,
  mark: number,
  injected: number,
  turnover: number,
  fills: Fill[],
  eq: number[],
): Result {
  const final = cash + tokens * mark;
  return {
    name,
    finalEquity: final,
    returnPct: (final / start - 1) * 100,
    maxDrawdownPct: drawdown(eq),
    realizedSol: cash - start + injected,
    tokenAmount: tokens,
    cashSol: cash,
    capitalInjectedSol: injected,
    turnoverSol: turnover,
    fills,
  };
}
function hold(t: Trade[], start: number, base: number, cost: number): Result {
  const p = feePrice(t[0]!.priceSol, "buy", cost);
  const spend = Math.min(base, start);
  const tok = spend / p;
  const cash = start - spend;
  const eq = t.map((x) => cash + tok * x.priceSol);
  return finalize(
    "hold",
    start,
    cash,
    tok,
    t.at(-1)!.priceSol,
    0,
    spend,
    [
      {
        atMs: t[0]!.tradedAtMs,
        side: "buy",
        price: p,
        sol: spend,
        tokens: tok,
        reason: "initial hold",
      },
    ],
    eq,
  );
}
function valueBand(
  t: Trade[],
  start: number,
  base: number,
  lower: number,
  upper: number,
  cost: number,
): Result {
  let cash = start,
    tok = 0,
    injected = 0,
    turn = 0;
  const fills: Fill[] = [];
  const eq: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const x = t[i]!,
      p = x.priceSol;
    if (i === 0 && tok === 0) {
      const spend = Math.min(base, cash);
      const ep = feePrice(p, "buy", cost);
      tok += spend / ep;
      cash -= spend;
      turn += spend;
      fills.push({
        atMs: x.tradedAtMs,
        side: "buy",
        price: ep,
        sol: spend,
        tokens: spend / ep,
        reason: "bootstrap",
      });
    }
    let liquidation = tok * feePrice(p, "sell", cost);
    if (liquidation >= base * upper && tok > 0) {
      const sold = tok * 0.5,
        ep = feePrice(p, "sell", cost),
        got = sold * ep;
      tok -= sold;
      cash += got;
      turn += got;
      fills.push({
        atMs: x.tradedAtMs,
        side: "sell",
        price: ep,
        sol: got,
        tokens: sold,
        reason: "upper band sell-half",
      });
    } else if (liquidation < base * lower && tok > 0) {
      const targetTokens = tok;
      const ep = feePrice(p, "buy", cost);
      const need = targetTokens * ep;
      const spend = Math.min(need, cash);
      if (spend > 0) {
        const bought = spend / ep;
        tok += bought;
        cash -= spend;
        turn += spend;
        fills.push({
          atMs: x.tradedAtMs,
          side: "buy",
          price: ep,
          sol: spend,
          tokens: bought,
          reason: "lower band match-current-units",
        });
      }
    }
    eq.push(cash + tok * p);
  }
  return finalize(
    "value-band",
    start,
    cash,
    tok,
    t.at(-1)!.priceSol,
    injected,
    turn,
    fills,
    eq,
  );
}
function targetWeight(
  t: Trade[],
  start: number,
  target: number,
  outer: number,
  inner: number,
  cost: number,
): Result {
  let cash = start,
    tok = 0,
    turn = 0;
  const fills: Fill[] = [];
  const eq: number[] = [];
  for (const x of t) {
    const p = x.priceSol;
    const nav = cash + tok * p;
    const w = nav > 0 ? (tok * p) / nav : 0;
    const lo = target - outer,
      hi = target + outer;
    if (w < lo && cash > 0) {
      const desired = target - inner;
      const desiredX = nav * desired;
      const currentX = tok * p;
      const spend = Math.min(cash, Math.max(0, desiredX - currentX));
      if (spend > 0) {
        const ep = feePrice(p, "buy", cost),
          b = spend / ep;
        cash -= spend;
        tok += b;
        turn += spend;
        fills.push({
          atMs: x.tradedAtMs,
          side: "buy",
          price: ep,
          sol: spend,
          tokens: b,
          reason: `weight ${(w * 100).toFixed(2)}% < ${(lo * 100).toFixed(2)}%`,
        });
      }
    } else if (w > hi && tok > 0) {
      const desired = target + inner;
      const desiredX = nav * desired;
      const currentX = tok * p;
      const sellValue = Math.max(0, currentX - desiredX);
      const sold = Math.min(tok, sellValue / p);
      if (sold > 0) {
        const ep = feePrice(p, "sell", cost),
          got = sold * ep;
        tok -= sold;
        cash += got;
        turn += got;
        fills.push({
          atMs: x.tradedAtMs,
          side: "sell",
          price: ep,
          sol: got,
          tokens: sold,
          reason: `weight ${(w * 100).toFixed(2)}% > ${(hi * 100).toFixed(2)}%`,
        });
      }
    }
    eq.push(cash + tok * p);
  }
  return finalize(
    "target-weight-40",
    start,
    cash,
    tok,
    t.at(-1)!.priceSol,
    0,
    turn,
    fills,
    eq,
  );
}
function athDip(
  t: Trade[],
  start: number,
  dip: number,
  tp: number,
  buy: number,
  cost: number,
): Result {
  let cash = start,
    tok = 0,
    ath = 0,
    turn = 0;
  const lots: { tokens: number; cost: number; entry: number }[] = [];
  const fills: Fill[] = [];
  const eq: number[] = [];
  for (const x of t) {
    const p = x.priceSol;
    ath = Math.max(ath, p);
    if (cash >= buy && p <= ath * (1 - dip)) {
      const ep = feePrice(p, "buy", cost),
        b = buy / ep;
      cash -= buy;
      tok += b;
      turn += buy;
      lots.push({ tokens: b, cost: buy, entry: ep });
      fills.push({
        atMs: x.tradedAtMs,
        side: "buy",
        price: ep,
        sol: buy,
        tokens: b,
        reason: "ATH dip",
      });
      ath = p / (1 - dip);
    }
    for (let i = lots.length - 1; i >= 0; i--) {
      const l = lots[i]!;
      if (p >= l.entry * (1 + tp)) {
        const ep = feePrice(p, "sell", cost),
          got = l.tokens * ep;
        cash += got;
        tok -= l.tokens;
        turn += got;
        fills.push({
          atMs: x.tradedAtMs,
          side: "sell",
          price: ep,
          sol: got,
          tokens: l.tokens,
          reason: "take profit",
        });
        lots.splice(i, 1);
      }
    }
    eq.push(cash + tok * p);
  }
  return finalize(
    "ath-dip-20-tp40",
    start,
    cash,
    tok,
    t.at(-1)!.priceSol,
    0,
    turn,
    fills,
    eq,
  );
}
function csv(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const h = [...new Set(rows.flatMap(Object.keys))];
  const c = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    h.map(c).join(",") +
    "\n" +
    rows.map((r) => h.map((k) => c(r[k])).join(",")).join("\n") +
    "\n"
  );
}
async function main() {
  const f = parseArgs(process.argv.slice(2));
  const path = resolve(req(f, "trades"));
  const t = load(path);
  if (!t.length) throw new Error("No usable trades");
  const start = num(f, "capital-sol", 5),
    base = num(f, "base-sol", 0.1),
    cost = num(f, "roundtrip-cost-bps", 0);
  const runs = [
    hold(t, start, base, cost),
    valueBand(
      t,
      start,
      base,
      num(f, "lower-multiple", 0.5),
      num(f, "upper-multiple", 1.8),
      cost,
    ),
    targetWeight(t, start, 0.4, 0.03, 0.01, cost),
    athDip(t, start, 0.2, 0.4, base, cost),
  ];
  runs.sort((a, b) => b.finalEquity - a.finalEquity);
  const out = resolve(flag(f, "out") ?? `${dirname(path)}/strategy-suite`);
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/summary.json`, JSON.stringify(runs, null, 2) + "\n");
  writeFileSync(
    `${out}/summary.csv`,
    csv(
      runs.map((r) => ({
        strategy: r.name,
        finalEquitySol: r.finalEquity,
        returnPct: r.returnPct,
        maxDrawdownPct: r.maxDrawdownPct,
        turnoverSol: r.turnoverSol,
        capitalInjectedSol: r.capitalInjectedSol,
        fills: r.fills.length,
      })),
    ),
  );
  for (const r of runs)
    writeFileSync(
      `${out}/${r.name}-ledger.csv`,
      csv(r.fills.map((x) => ({ ...x, at: new Date(x.atMs).toISOString() }))),
    );
  console.log(
    `RAYDIUM STRATEGY SUITE\nTrades: ${t.length}\nPeriod: ${new Date(t[0]!.tradedAtMs).toISOString()} -> ${new Date(t.at(-1)!.tradedAtMs).toISOString()}\nResults: ${out}\n`,
  );
  for (const [i, r] of runs.entries())
    console.log(
      `${i + 1}. ${r.name.padEnd(22)} final=${r.finalEquity.toFixed(6)} SOL  return=${r.returnPct.toFixed(2)}%  dd=${r.maxDrawdownPct.toFixed(2)}%  trades=${r.fills.length}`,
    );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
