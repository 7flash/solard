#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  backfillTokenHistory,
  backfillRaydiumTokenHistory,
  createTraderSolard,
  getTokenHistoryCoverage,
  loadTokenHistoryTrades,
  quoteJupiterSwap,
  backtestTargetWeightToken,
  backtestTokenTrades,
  TokenHistoryError,
} from "@solard/sdk";
import { simulateValueBandStrategy } from "../packages/core/src/backtest/value-band-sim.ts";

const WSOL = "So11111111111111111111111111111111111111112";
type Flags = Map<string, string>;
function parse(argv: string[]): Flags {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (!v.startsWith("--")) continue;
    const [k, x] = v.slice(2).split("=", 2);
    if (x != null) m.set(k!, x);
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--"))
      m.set(k!, argv[++i]!);
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
  const n = Number(flag(f, k) ?? d);
  if (!Number.isFinite(n)) throw new Error(`Invalid --${k}`);
  return n;
}
function pct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}
function median(xs: number[]) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}
function json(v: unknown) {
  return JSON.stringify(
    v,
    (_k, x) => (typeof x === "bigint" ? x.toString() : x),
    2,
  );
}
function csv(rows: any[]) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const q = (v: any) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return (
    keys.join(",") +
    "\n" +
    rows.map((r) => keys.map((k) => q(r[k])).join(",")).join("\n") +
    "\n"
  );
}

function earlyAnalysis(trades: any[], windowMs: number) {
  const buys = trades.filter((t) => t.side === "buy" && t.owner);
  const start = buys[0]?.tradedAtMs ?? null;
  if (start == null)
    return { start: null, buyers: [], clusters: [], concentration: null };
  const early = buys.filter((t) => t.tradedAtMs <= start + windowMs);
  const byOwner = new Map<
    string,
    {
      owner: string;
      tokens: number;
      sol: number;
      trades: number;
      firstAtMs: number;
    }
  >();
  for (const t of early) {
    const r = byOwner.get(t.owner) ?? {
      owner: t.owner,
      tokens: 0,
      sol: 0,
      trades: 0,
      firstAtMs: t.tradedAtMs,
    };
    r.tokens += Math.abs(t.tokenDeltaUi);
    r.sol += Math.abs(t.solDeltaUi);
    r.trades++;
    r.firstAtMs = Math.min(r.firstAtMs, t.tradedAtMs);
    byOwner.set(t.owner, r);
  }
  const buyers = [...byOwner.values()].sort((a, b) => b.tokens - a.tokens);
  const total = buyers.reduce((n, r) => n + r.tokens, 0);
  const share = (n: number) =>
    total > 0
      ? (buyers.slice(0, n).reduce((x, r) => x + r.tokens, 0) / total) * 100
      : 0;
  const groups = new Map<string, any[]>();
  for (const t of early) {
    const k = `${t.slot}:${t.signature}`;
    const g = groups.get(k) ?? [];
    g.push(t);
    groups.set(k, g);
  }
  const clusters = [...groups.entries()]
    .filter(([, g]) => new Set(g.map((x) => x.owner)).size >= 2)
    .map(([key, g]) => ({
      key,
      slot: g[0].slot,
      signature: g[0].signature,
      buyers: [...new Set(g.map((x) => x.owner))],
      sol: g.reduce((n, x) => n + Math.abs(x.solDeltaUi), 0),
      classification: "bundle-like:same-signature",
    }));
  const slotGroups = new Map<number, any[]>();
  for (const t of early) {
    const g = slotGroups.get(t.slot) ?? [];
    g.push(t);
    slotGroups.set(t.slot, g);
  }
  for (const [slot, g] of slotGroups) {
    const owners = [...new Set(g.map((x) => x.owner))];
    if (owners.length >= 3 && !clusters.some((c) => c.slot === slot))
      clusters.push({
        key: `slot:${slot}`,
        slot,
        signature: null,
        buyers: owners,
        sol: g.reduce((n, x) => n + Math.abs(x.solDeltaUi), 0),
        classification: "bundle-like:same-slot",
      });
  }
  return {
    start,
    windowMs,
    buyers,
    clusters,
    concentration: {
      buyers: buyers.length,
      top1Pct: share(1),
      top5Pct: share(5),
      top10Pct: share(10),
      totalBuyTokens: total,
      totalBuySol: buyers.reduce((n, r) => n + r.sol, 0),
    },
  };
}

function empiricalFriction(trades: any[]) {
  const buckets = new Map<number, { buys: number[]; sells: number[] }>();
  for (const t of trades) {
    if (!(t.priceSol > 0)) continue;
    const b = Math.floor(t.tradedAtMs / 1000);
    const row = buckets.get(b) ?? { buys: [], sells: [] };
    row[t.side === "buy" ? "buys" : "sells"].push(t.priceSol);
    buckets.set(b, row);
  }
  const ratios: number[] = [];
  for (const row of buckets.values()) {
    const b = median(row.buys),
      s = median(row.sells);
    if (b && s && b >= s) ratios.push(b / s - 1);
  }
  const m = median(ratios);
  return {
    pairedSeconds: ratios.length,
    medianRoundTripPct: m == null ? null : m * 100,
    approxOneWayBps: m == null ? null : (Math.sqrt(1 + m) - 1) * 10000,
  };
}

async function currentRoundTrip(mint: string, solAmount: number) {
  const inRaw = BigInt(Math.max(1, Math.round(solAmount * 1e9)));
  const buy = await quoteJupiterSwap({
    inputMint: WSOL,
    outputMint: mint,
    amountRaw: inRaw,
  });
  const tokenRaw = BigInt(buy.outAmountRaw);
  const sell = await quoteJupiterSwap({
    inputMint: mint,
    outputMint: WSOL,
    amountRaw: tokenRaw,
  });
  const out = Number(sell.outAmountRaw) / 1e9;
  return {
    inputSol: solAmount,
    tokensRaw: tokenRaw.toString(),
    roundTripSol: out,
    lossPct: (1 - out / solAmount) * 100,
    buyRouter: (buy as any).router ?? null,
    sellRouter: (sell as any).router ?? null,
  };
}

async function main() {
  const f = parse(process.argv.slice(2));
  const mint = flag(f, "mint") ?? req(f, "token");
  const capital = num(f, "capital-sol", 1);
  const base = num(f, "base-sol", 0.1);
  const maxCapital = num(f, "max-capital-sol", Math.max(base * 5, capital));
  const outDir = resolve(
    flag(f, "out") ??
      `.solard/research/${mint}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  mkdirSync(outDir, { recursive: true });
  const slrd = createTraderSolard();
  if (!f.has("no-backfill")) {
    try {
      await backfillTokenHistory(slrd.connection(), mint, {
        replace: f.has("replace"),
      });
    } catch (e) {
      if (!(e instanceof TokenHistoryError) || e.code !== "UNSUPPORTED_TOKEN")
        throw e;
      console.log("Pump history unsupported; backfilling Raydium/LaunchLab...");
      await backfillRaydiumTokenHistory(slrd.connection(), mint, {
        replace: f.has("replace"),
        maxRaydiumPools: Math.max(1, Math.trunc(num(f, "raydium-pools", 8))),
      });
    }
  }
  const trades = loadTokenHistoryTrades(mint);
  if (trades.length < 2)
    throw new Error("No durable history. Run backfill without --no-backfill.");
  const coverage = getTokenHistoryCoverage(mint);
  const tape = trades
    .filter((t: any) => t.priceSol > 0 && t.confidence !== "dropped")
    .map((t: any) => ({
      atMs: t.tradedAtMs,
      priceSol: t.priceSol,
      id: t.eventKey,
    }));
  const first = tape[0]!,
    last = tape.at(-1)!;
  const holdTokens = base / first.priceSol;
  const holdFinal = capital - base + holdTokens * last.priceSol;
  const holdReturn = (holdFinal / capital - 1) * 100;
  const friction = empiricalFriction(trades);
  const executionBps = Math.max(
    0,
    num(f, "execution-bps", friction.approxOneWayBps ?? 0),
  );
  const variants = ["same-value", "to-base", "same-tokens"].map((mode) => ({
    mode,
    result: simulateValueBandStrategy(
      tape,
      {
        version: 1,
        kind: "value-band",
        baseSol: base,
        lowerMultiple: num(f, "lower-multiple", 0.5),
        upperMultiple: num(f, "upper-multiple", 1.8),
        sellFraction: num(f, "sell-fraction", 0.5),
        buyMode: mode as any,
        minTradeSol: num(f, "min-trade-sol", 0.001),
        maxCapitalDeployedSol: maxCapital,
      },
      {
        startingSol: capital,
        executionBps,
        networkFeeSol: num(f, "network-fee-sol", 0.00001),
      },
    ),
  }));
  const tw = backtestTargetWeightToken(
    mint,
    {
      version: 1,
      kind: "target-weight",
      targetWeightPct: num(f, "target-weight", 40),
      gap: {
        mode: "fixed",
        outerPct: num(f, "gap-pct", 3),
        innerPct: num(f, "inner-gap-pct", 1),
      },
      minTradeSol: num(f, "min-trade-sol", 0.001),
      execution: {
        slippageBps: executionBps,
        venueFeeBps: 0,
        networkFeeSol: num(f, "network-fee-sol", 0.00001),
        latencyMs: 0,
      },
    },
    { startingSol: capital, requireFromCreation: false, source: "trades" },
  );
  const legacy = backtestTokenTrades(
    mint,
    {
      version: 1,
      kind: "ath-dip-profit-ladder",
      name: "legacy ATH -20 / TP +40",
      metric: "priceSol",
      entry: { stepPct: 20, buySol: base, catchUpLevels: true },
      exit: { profitPct: 40 },
      execution: {
        slippageBps: executionBps,
        venueFeeBps: 0,
        networkFeeSol: num(f, "network-fee-sol", 0.00001),
        latencyMs: 0,
      },
    },
    { startingSol: capital, requireFromCreation: false, source: "trades" },
  );
  const early = earlyAnalysis(trades, num(f, "early-window-ms", 60000));
  const probe = [];
  if (!f.has("no-probe")) {
    for (const amount of [0.01, 0.05, 0.1]) {
      try {
        probe.push(await currentRoundTrip(mint, amount));
      } catch (e) {
        probe.push({
          inputSol: amount,
          error: e instanceof Error ? e.message : String(e),
        } as any);
      }
    }
  }
  const summary = [
    {
      id: "hold-0.1-sleeve",
      returnPct: holdReturn,
      finalEquitySol: holdFinal,
      maxDrawdownPct: null,
      trades: 1,
      peakCapitalSol: base,
    },
    ...variants.map((v) => ({
      id: `value-band-${v.mode}`,
      returnPct: v.result.summary.returnPct,
      finalEquitySol: v.result.summary.finalEquitySol,
      maxDrawdownPct: v.result.summary.maxDrawdownPct,
      trades: v.result.summary.buys + v.result.summary.sells,
      peakCapitalSol: v.result.summary.peakNetCapitalDeployedSol,
    })),
    {
      id: "target-weight",
      returnPct: tw.summary.returnPct,
      finalEquitySol: tw.summary.finalEquitySol,
      maxDrawdownPct: tw.summary.maxDrawdownPct,
      trades: tw.summary.buys + tw.summary.sells,
      peakCapitalSol: null,
    },
    {
      id: "legacy-ath-dip-tp",
      returnPct: legacy.summary.returnPct,
      finalEquitySol: legacy.summary.finalEquitySol,
      maxDrawdownPct: legacy.summary.maxDrawdownPct,
      trades: legacy.summary.buys + legacy.summary.sells,
      peakCapitalSol: null,
    },
  ].sort((a, b) => b.returnPct - a.returnPct);
  const report = {
    mint,
    coverage,
    history: {
      trades: trades.length,
      firstAt: new Date(first.atMs).toISOString(),
      lastAt: new Date(last.atMs).toISOString(),
    },
    friction: {
      empirical: friction,
      simulationOneWayBps: executionBps,
      currentRoundTrips: probe,
    },
    early,
    summary,
  };
  writeFileSync(resolve(outDir, "report.json"), json(report));
  writeFileSync(resolve(outDir, "comparison.csv"), csv(summary));
  writeFileSync(resolve(outDir, "early-buyers.csv"), csv(early.buyers));
  writeFileSync(
    resolve(outDir, "bundle-like-clusters.json"),
    json(early.clusters),
  );
  for (const v of variants)
    writeFileSync(
      resolve(outDir, `ledger-value-band-${v.mode}.csv`),
      csv(v.result.executions),
    );
  console.log(
    `STONKFUN / RAYDIUM RESEARCH\nMint: ${mint}\nCoverage: ${coverage?.complete && coverage?.fromCreation ? "COMPLETE FROM CREATION" : "PARTIAL"}\nTrades: ${trades.length}\nEmpirical friction: ${friction.medianRoundTripPct == null ? "n/a" : friction.medianRoundTripPct.toFixed(2) + "% round-trip"}\nResults: ${outDir}\n`,
  );
  console.log(
    "RANK  STRATEGY                         RETURN     FINAL SOL  MAX DD   TRADES  PEAK CAPITAL",
  );
  summary.forEach((r, i) =>
    console.log(
      `${String(i + 1).padStart(4)}  ${r.id.padEnd(32)} ${pct(r.returnPct).padStart(9)}  ${r.finalEquitySol.toFixed(6).padStart(10)}  ${(r.maxDrawdownPct == null ? "-" : pct(r.maxDrawdownPct)).padStart(7)}  ${String(r.trades).padStart(6)}  ${(r.peakCapitalSol == null ? "-" : r.peakCapitalSol.toFixed(4)).padStart(12)}`,
    ),
  );
  slrd.close();
}
main().catch((e) => {
  console.error("RESEARCH ERROR", e);
  process.exitCode = 1;
});
