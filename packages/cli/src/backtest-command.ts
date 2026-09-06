import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  backtestTokenTrades,
  type AthDipProfitStrategy,
  type TokenAthDipProfitBacktestResult,
} from "@solard/sdk";

type Flags = Map<string, string>;
type Emit = (value: string) => void;

function flag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function numberFlag(
  flags: Flags,
  key: string,
  fallback?: number,
): number | undefined {
  const value = flag(flags, key);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${value}`);
  return parsed;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function readStrategy(flags: Flags): AthDipProfitStrategy {
  const path = flag(flags, "strategy");
  if (path) {
    const parsed = JSON.parse(
      readFileSync(resolve(path), "utf8"),
    ) as AthDipProfitStrategy;
    const execution = { ...(parsed.execution ?? {}) };
    if (flag(flags, "slippage-bps") != null)
      execution.slippageBps = numberFlag(flags, "slippage-bps");
    if (flag(flags, "venue-fee-bps") != null)
      execution.venueFeeBps = numberFlag(flags, "venue-fee-bps");
    if (flag(flags, "network-fee-sol") != null)
      execution.networkFeeSol = numberFlag(flags, "network-fee-sol");
    if (flag(flags, "latency-ms") != null)
      execution.latencyMs = numberFlag(flags, "latency-ms");
    return { ...parsed, execution };
  }

  const dipPct = numberFlag(flags, "dip-pct");
  const profitPct = numberFlag(flags, "profit-pct");
  const buySol = numberFlag(flags, "buy-sol");
  if (dipPct == null || profitPct == null || buySol == null) {
    throw new Error(
      "Usage: slrd backtest <mint> --strategy <file.json> [options]\n" +
        "   or: slrd backtest <mint> --dip-pct 20 --profit-pct 40 --buy-sol 0.1 [options]",
    );
  }
  const metricFlag = flag(flags, "metric") ?? "price-sol";
  const metric = metricFlag === "market-cap-usd" ? "marketCapUsd" : "priceSol";
  if (metricFlag !== "price-sol" && metricFlag !== "market-cap-usd") {
    throw new Error("--metric must be price-sol or market-cap-usd");
  }
  return {
    version: 1,
    kind: "ath-dip-profit-ladder",
    name: `ATH dip ${dipPct}% / TP ${profitPct}%`,
    metric,
    entry: {
      stepPct: dipPct,
      buySol,
      ...(numberFlag(flags, "max-levels") != null
        ? { maxLevels: numberFlag(flags, "max-levels") }
        : {}),
      catchUpLevels: !flags.has("no-catch-up"),
    },
    exit: { profitPct },
    execution: {
      slippageBps: numberFlag(flags, "slippage-bps", 0),
      venueFeeBps: numberFlag(flags, "venue-fee-bps", 0),
      networkFeeSol: numberFlag(flags, "network-fee-sol", 0),
      latencyMs: numberFlag(flags, "latency-ms", 0),
    },
  };
}

function fmtSol(value: number): string {
  return `${value >= 0 ? "" : "-"}${Math.abs(value).toFixed(6)} SOL`;
}

function fmtPct(value: number | null): string {
  return value == null ? "n/a" : `${value.toFixed(2)}%`;
}

function fmtTime(ms: number | null): string {
  if (ms == null) return "n/a";
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(2)}d`;
}

function humanReport(result: TokenAthDipProfitBacktestResult): string {
  const s = result.summary;
  const coverage = result.coverage;
  const coverageLine =
    coverage.status === "likely-from-creation"
      ? `likely from creation (gap ${coverage.creationGapMs ?? 0}ms)`
      : coverage.status === "partial"
        ? `PARTIAL: first stored trade is ${coverage.creationGapMs}ms after token.createdAtMs`
        : "UNKNOWN: token creation boundary cannot be proven locally";
  return [
    "SLRD BACKTEST",
    `Mint: ${result.mint}`,
    `Strategy: ${result.strategy.name ?? result.strategy.kind}`,
    `Tape: ${result.tape.events} usable events (${result.input.sourceRows} ${result.input.source} rows)`,
    `Period: ${result.tape.firstAtMs ? new Date(result.tape.firstAtMs).toISOString() : "n/a"} -> ${result.tape.lastAtMs ? new Date(result.tape.lastAtMs).toISOString() : "n/a"}`,
    `Coverage: ${coverageLine}`,
    "",
    `Starting capital:        ${fmtSol(s.startingSol)}`,
    `Ending cash:             ${fmtSol(s.endingCashSol)}`,
    `Open liquidation value:  ${fmtSol(s.openLiquidationValueSol)}`,
    `Final equity:            ${fmtSol(s.finalEquitySol)}`,
    `Net P&L:                 ${fmtSol(s.netPnlSol)} (${fmtPct(s.returnPct)})`,
    `Realized P&L:            ${fmtSol(s.realizedPnlSol)}`,
    `Unrealized P&L:          ${fmtSol(s.unrealizedPnlSol)}`,
    `Max drawdown:            ${fmtPct(s.maxDrawdownPct)}`,
    `Max deployed:            ${fmtSol(s.maxDeployedSol)}`,
    "",
    `Buys / sells:            ${s.buys} / ${s.sells}`,
    `Closed / open lots:      ${s.closedLots} / ${s.openLots}`,
    `Wins / losses:           ${s.winningLots} / ${s.losingLots}`,
    `Win rate:                ${fmtPct(s.winRatePct)}`,
    `Skipped entries:         ${s.skippedEntries}`,
    `Average hold:            ${fmtTime(s.averageHoldMs)}`,
    `Fastest / longest hold:  ${fmtTime(s.fastestHoldMs)} / ${fmtTime(s.longestHoldMs)}`,
  ].join("\n");
}

export async function runBacktestCommand(args: {
  values: string[];
  flags: Flags;
  emit: Emit;
}): Promise<void> {
  const mint = args.values[0]?.trim();
  if (!mint) {
    throw new Error(
      "Usage: slrd backtest <mint> --strategy <file.json> [--capital-sol 5] [--require-from-start]",
    );
  }
  const strategy = readStrategy(args.flags);
  const result = backtestTokenTrades(mint, strategy, {
    startingSol: numberFlag(args.flags, "capital-sol", 5),
    includeProcessed: !args.flags.has("confirmed-only"),
    coverageToleranceMs: numberFlag(
      args.flags,
      "coverage-tolerance-ms",
      60_000,
    ),
    requireFromCreation: args.flags.has("require-from-start"),
    source: args.flags.has("exact-trades") ? "trades" : "candles-1s",
  });

  const out = flag(args.flags, "out");
  if (out) {
    const path = resolve(out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${json(result)}\n`);
  }

  if (args.flags.has("json")) {
    args.emit(`${json(result)}\n`);
  } else {
    args.emit(`${humanReport(result)}\n`);
    if (out) args.emit(`Full result: ${resolve(out)}\n`);
    if (args.flags.has("ledger")) {
      args.emit("\nEXECUTION LEDGER\n");
      for (const row of result.executions) {
        args.emit(
          `${new Date(row.atMs).toISOString()}  ${row.side.toUpperCase().padEnd(4)}  ${row.status.padEnd(7)}  ` +
            `lot=${row.lotId ?? "-"} level=${row.level ?? "-"} price=${row.observedPriceSol} ` +
            `${row.amountSol == null ? "" : `sol=${row.amountSol}`} ${row.reason ?? ""}\n`,
        );
      }
    }
  }
}
