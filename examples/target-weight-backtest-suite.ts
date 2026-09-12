#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  backtestTargetWeightToken,
  backtestTokenTrades,
  getTokenHistoryCoverage,
  loadTokenHistoryTrades,
  type AthDipProfitStrategy,
  type TargetWeightPolicy,
  type TokenAthDipProfitBacktestResult,
  type TokenTargetWeightBacktestResult,
} from "@solard/core";

type Flags = Map<string, string>;
type Result = TokenTargetWeightBacktestResult | TokenAthDipProfitBacktestResult;

type Variant = {
  id: string;
  label: string;
  strategy: TargetWeightPolicy | AthDipProfitStrategy;
};

function parseArgs(argv: string[]): Flags {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i]!;
    if (!current.startsWith("--")) continue;
    const [key, inline] = current.slice(2).split("=", 2);
    if (inline != null) flags.set(key!, inline);
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--"))
      flags.set(key!, argv[++i]!);
    else flags.set(key!, "true");
  }
  return flags;
}

function flag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function required(flags: Flags, key: string): string {
  const value = flag(flags, key);
  if (!value) throw new Error(`Missing --${key} <value>`);
  return value;
}

function numberFlag(flags: Flags, key: string, fallback: number): number {
  const value = flag(flags, key);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${value}`);
  return parsed;
}

function timeMs(value: string): number {
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    return n < 10_000_000_000 ? Math.trunc(n * 1_000) : Math.trunc(n);
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid time: ${value}`);
  return parsed;
}

function replayStart(
  mint: string,
  value: string,
): { ms?: number; label: string } {
  const coverage = getTokenHistoryCoverage(mint);
  if (value === "creation") {
    return coverage?.creationAtMs == null
      ? { label: "creation unavailable; first usable event" }
      : {
          ms: coverage.creationAtMs,
          label: `creation ${new Date(coverage.creationAtMs).toISOString()}`,
        };
  }
  if (value === "migration" || value === "pumpswap") {
    const first = loadTokenHistoryTrades(mint).find(
      (row) =>
        row.history.venue === "pumpswap" || row.source === "history:pumpswap",
    );
    const ms =
      first?.tradedAtMs ??
      (coverage?.pumpswap?.oldestBlockTime == null
        ? undefined
        : coverage.pumpswap.oldestBlockTime * 1_000);
    if (ms == null)
      throw new Error(
        `No durable PumpSwap migration boundary found for ${mint}`,
      );
    return { ms, label: `migration ${new Date(ms).toISOString()}` };
  }
  const ms = timeMs(value);
  return { ms, label: new Date(ms).toISOString() };
}

function targetWeight(args: {
  id: string;
  label: string;
  target: number;
  outer: number;
  inner: number;
  mode?: "fixed" | "previous-5m-vol";
  multiplier?: number;
  costs: {
    slippageBps: number;
    venueFeeBps: number;
    networkFeeSol: number;
    latencyMs: number;
  };
  minTradeSol: number;
}): Variant {
  return {
    id: args.id,
    label: args.label,
    strategy: {
      version: 1,
      kind: "target-weight",
      name: args.label,
      targetWeightPct: args.target,
      gap: {
        mode: args.mode ?? "fixed",
        outerPct: args.outer,
        innerPct: args.inner,
        volatilityMultiplier: args.multiplier ?? 2,
        minPct: 1,
        maxPct: 8,
      },
      minTradeSol: args.minTradeSol,
      execution: args.costs,
    },
  };
}

function variants(flags: Flags): Variant[] {
  const costs = {
    slippageBps: numberFlag(flags, "slippage-bps", 0),
    venueFeeBps: numberFlag(flags, "venue-fee-bps", 0),
    networkFeeSol: numberFlag(flags, "network-fee-sol", 0),
    latencyMs: numberFlag(flags, "latency-ms", 0),
  };
  const minTradeSol = numberFlag(flags, "min-trade-sol", 0.001);
  return [
    targetWeight({
      id: "tw20-fixed3",
      label: "TW 20% fixed 3pp→1pp",
      target: 20,
      outer: 3,
      inner: 1,
      costs,
      minTradeSol,
    }),
    targetWeight({
      id: "tw40-fixed1",
      label: "TW 40% fixed 1pp→0.5pp",
      target: 40,
      outer: 1,
      inner: 0.5,
      costs,
      minTradeSol,
    }),
    targetWeight({
      id: "tw40-fixed3",
      label: "TW 40% fixed 3pp→1pp",
      target: 40,
      outer: 3,
      inner: 1,
      costs,
      minTradeSol,
    }),
    targetWeight({
      id: "tw40-fixed5",
      label: "TW 40% fixed 5pp→1pp",
      target: 40,
      outer: 5,
      inner: 1,
      costs,
      minTradeSol,
    }),
    targetWeight({
      id: "tw60-fixed3",
      label: "TW 60% fixed 3pp→1pp",
      target: 60,
      outer: 3,
      inner: 1,
      costs,
      minTradeSol,
    }),
    targetWeight({
      id: "tw40-vol1",
      label: "TW 40% previous-5m vol ×1",
      target: 40,
      outer: 3,
      inner: 1,
      mode: "previous-5m-vol",
      multiplier: 1,
      costs,
      minTradeSol,
    }),
    targetWeight({
      id: "tw40-vol2",
      label: "TW 40% previous-5m vol ×2",
      target: 40,
      outer: 3,
      inner: 1,
      mode: "previous-5m-vol",
      multiplier: 2,
      costs,
      minTradeSol,
    }),
    {
      id: "ath20-tp40",
      label: "ATH dip 20% / TP 40%",
      strategy: {
        version: 1,
        kind: "ath-dip-profit-ladder",
        name: "ATH dip 20% / TP 40%",
        metric: "priceSol",
        entry: { stepPct: 20, buySol: 0.1, catchUpLevels: true },
        exit: { profitPct: 40 },
        execution: costs,
      },
    },
  ];
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return (
    [
      headers.map(csvCell).join(","),
      ...rows.map((row) => headers.map((key) => csvCell(row[key])).join(",")),
    ].join("\n") + "\n"
  );
}

function executionLedger(result: Result): string {
  if (result.strategy.kind === "target-weight") {
    return csv(
      (result as TokenTargetWeightBacktestResult).executions.map((row) => ({
        at: new Date(row.atMs).toISOString(),
        side: row.side,
        status: row.status,
        observedPriceSol: row.observedPriceSol,
        executionPriceSol: row.executionPriceSol,
        amountSol: row.amountSol,
        tokens: row.tokens,
        targetWeightPct: row.targetWeightPct,
        desiredWeightPct: row.desiredWeightPct,
        weightBeforePct: row.weightBeforePct,
        weightAfterPct: row.weightAfterPct,
        outerGapPct: row.outerGapPct,
        innerGapPct: row.innerGapPct,
        previousCandleStart:
          row.previousCandleStartMs == null
            ? ""
            : new Date(row.previousCandleStartMs).toISOString(),
        previousCandleEnd:
          row.previousCandleEndMs == null
            ? ""
            : new Date(row.previousCandleEndMs).toISOString(),
        previousCandleRangePct: row.previousCandleRangePct,
        signature: row.signature,
        source: row.source,
        reason: row.reason,
      })),
    );
  }
  return csv(
    (result as TokenAthDipProfitBacktestResult).executions.map((row) => ({
      at: new Date(row.atMs).toISOString(),
      side: row.side,
      status: row.status,
      lotId: row.lotId,
      level: row.level,
      observedPriceSol: row.observedPriceSol,
      executionPriceSol: row.executionPriceSol,
      amountSol: row.amountSol,
      tokens: row.tokens,
      signature: row.signature,
      source: row.source,
      reason: row.reason,
    })),
  );
}

function fmtPct(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "-"
    : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.has("help")) {
    console.log(
      "Usage: slrd run examples/target-weight-backtest-suite.ts --mint <mint> " +
        "[--from migration|creation|time] [--to time] [--capital-sol 5] " +
        "[--slippage-bps N --venue-fee-bps N --network-fee-sol N --latency-ms N] [--out dir]",
    );
    return;
  }

  const mint = flag(flags, "mint") ?? required(flags, "token");
  const start = replayStart(mint, flag(flags, "from") ?? "migration");
  const toRaw = flag(flags, "to");
  const toMs = toRaw ? timeMs(toRaw) : undefined;
  const startingSol = numberFlag(flags, "capital-sol", 5);
  const source = flags.has("candles-1s")
    ? ("candles-1s" as const)
    : ("trades" as const);
  const common = {
    startingSol,
    fromMs: start.ms,
    toMs,
    source,
    includeProcessed: !flags.has("confirmed-only"),
    priceSanity: !flags.has("no-price-sanity"),
    isolatedPriceSpikeRatio: numberFlag(flags, "price-spike-ratio", 1000),
    priceContinuityRatio: numberFlag(flags, "price-continuity-ratio", 5),
    priceSanityWindow: numberFlag(flags, "price-sanity-window", 20),
    priceSanityWindowMs: numberFlag(flags, "price-sanity-window-ms", 300_000),
  };

  const runs: Array<{ variant: Variant; result: Result }> = [];
  for (const variant of variants(flags)) {
    const result =
      variant.strategy.kind === "target-weight"
        ? backtestTargetWeightToken(mint, variant.strategy, {
            ...common,
            cadenceMs: 300_000,
          })
        : backtestTokenTrades(mint, variant.strategy, common);
    runs.push({ variant, result });
  }

  const summary = runs
    .map(({ variant, result }) => {
      const tw =
        result.strategy.kind === "target-weight"
          ? (result as TokenTargetWeightBacktestResult)
          : null;
      return {
        id: variant.id,
        label: variant.label,
        kind: result.strategy.kind,
        returnPct: result.summary.returnPct,
        netPnlSol: result.summary.netPnlSol,
        maxDrawdownPct: result.summary.maxDrawdownPct,
        buys: result.summary.buys,
        sells: result.summary.sells,
        trades: result.summary.buys + result.summary.sells,
        turnoverSol: tw?.summary.totalTurnoverSol ?? null,
        executionCostSol: tw?.summary.totalExecutionCostSol ?? null,
        benchmarkInitialMixReturnPct:
          tw?.summary.benchmarkInitialMixReturnPct ?? null,
        excessVsInitialMixPct: tw?.summary.excessVsInitialMixPct ?? null,
        anomaliesExcluded: result.input.skippedAnomalousPrice,
        firstAt:
          result.tape.firstAtMs == null
            ? null
            : new Date(result.tape.firstAtMs).toISOString(),
        lastAt:
          result.tape.lastAtMs == null
            ? null
            : new Date(result.tape.lastAtMs).toISOString(),
      };
    })
    .sort((a, b) => b.returnPct - a.returnPct);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(
    flag(flags, "out") ??
      join("backtest-results", `${mint}-target-weight-suite-${stamp}`),
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "summary.csv"), csv(summary));
  writeFileSync(
    join(outDir, "summary.json"),
    `${JSON.stringify({ mint, replayStart: start.label, replayEnd: toMs == null ? null : new Date(toMs).toISOString(), source, startingSol, summary }, null, 2)}\n`,
  );
  for (const { variant, result } of runs) {
    writeFileSync(
      join(outDir, `${variant.id}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    writeFileSync(
      join(outDir, `${variant.id}-ledger.csv`),
      executionLedger(result),
    );
  }

  console.log(
    `TARGET-WEIGHT BACKTEST SUITE\nMint: ${mint}\nFrom: ${start.label}\nSource: ${source}\nCapital: ${startingSol} SOL\nResults: ${outDir}\n`,
  );
  console.log(
    "RANK  VARIANT                         RETURN      MAX DD   TRADES    EXCESS VS MIX",
  );
  summary.forEach((row, index) => {
    console.log(
      `${String(index + 1).padStart(4)}  ${row.id.padEnd(30)} ` +
        `${fmtPct(row.returnPct).padStart(10)} ` +
        `${fmtPct(-Math.abs(row.maxDrawdownPct)).padStart(10)} ` +
        `${String(row.trades).padStart(8)} ` +
        `${fmtPct(row.excessVsInitialMixPct).padStart(16)}`,
    );
  });
  console.log(
    "\nFull results and execution ledgers were written to files; they are not dumped to the terminal.",
  );
  if (summary.some((row) => row.anomaliesExcluded > 0)) {
    console.log(
      `Price sanity excluded anomalous events (max in a run: ${Math.max(...summary.map((row) => row.anomaliesExcluded))}).`,
    );
  }
}

main().catch((error) => {
  console.error("TARGET-WEIGHT SUITE ERROR", error);
  process.exitCode = 1;
});
