import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  backtestTargetWeightToken,
  backtestTokenTrades,
  getTokenHistoryCoverage,
  loadTokenHistoryTrades,
  type AthDipProfitStrategy,
  type TargetWeightPolicy,
  type TokenAthDipProfitBacktestResult,
  type TokenTargetWeightBacktestResult,
} from "@solard/sdk";

type Flags = Map<string, string>;
type Emit = (value: string) => void;
type CliStrategy = AthDipProfitStrategy | TargetWeightPolicy;
type CliBacktestResult =
  TokenAthDipProfitBacktestResult | TokenTargetWeightBacktestResult;

type ReplayWindow = {
  fromMs?: number;
  toMs?: number;
  fromLabel: string;
  toLabel: string;
};

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

function parseDurationMs(
  value: string | undefined,
  fallbackMs: number,
): number {
  if (!value) return fallbackMs;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(value.trim());
  if (!match)
    throw new Error(`Invalid duration: ${value}. Use e.g. 500ms, 5s, 5m, 1h.`);
  const n = Number(match[1]);
  const unit = (match[2]?.toLowerCase() ?? "ms") as "ms" | "s" | "m" | "h";
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit];
  return Math.max(1_000, Math.trunc(n * scale));
}

function parseReplayTime(value: string, label: string): number {
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric) || numeric < 0)
      throw new Error(`Invalid ${label}: ${value}`);
    return numeric < 10_000_000_000
      ? Math.trunc(numeric * 1_000)
      : Math.trunc(numeric);
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Invalid ${label}: ${value}. Use creation, migration, an ISO timestamp, Unix seconds, or Unix milliseconds.`,
    );
  }
  return parsed;
}

function resolveReplayWindow(mint: string, flags: Flags): ReplayWindow {
  const coverage = getTokenHistoryCoverage(mint);
  const fromRaw = flag(flags, "from") ?? "creation";
  let fromMs: number | undefined;
  let fromLabel: string;

  if (fromRaw === "creation") {
    fromMs = coverage?.creationAtMs ?? undefined;
    fromLabel =
      fromMs == null
        ? "creation requested; local creation timestamp unavailable, using first usable event"
        : `creation ${new Date(fromMs).toISOString()}`;
  } else if (fromRaw === "migration" || fromRaw === "pumpswap") {
    const firstPumpSwap = loadTokenHistoryTrades(mint).find(
      (row) =>
        row.history?.venue === "pumpswap" || row.source === "history:pumpswap",
    );
    const coverageFallback =
      coverage?.pumpswap?.oldestBlockTime != null
        ? coverage.pumpswap.oldestBlockTime * 1_000
        : undefined;
    fromMs = firstPumpSwap?.tradedAtMs ?? coverageFallback;
    if (fromMs == null) {
      throw new Error(
        `--from ${fromRaw} requested, but no PumpSwap/migration boundary is present in durable history for ${mint}.`,
      );
    }
    fromLabel = `migration / first PumpSwap activity ${new Date(fromMs).toISOString()}`;
  } else {
    fromMs = parseReplayTime(fromRaw, "--from");
    fromLabel = `explicit ${new Date(fromMs).toISOString()}`;
  }

  const toRaw = flag(flags, "to");
  const toMs = toRaw == null ? undefined : parseReplayTime(toRaw, "--to");
  if (fromMs != null && toMs != null && toMs < fromMs) {
    throw new Error("--to must be at or after --from");
  }
  return {
    fromMs,
    toMs,
    fromLabel,
    toLabel:
      toMs == null ? "end of durable tape" : new Date(toMs).toISOString(),
  };
}

function applyExecutionOverrides(
  strategy: CliStrategy,
  flags: Flags,
): CliStrategy {
  const execution: Record<string, number | undefined> = {
    ...(strategy.execution ?? {}),
  };
  if (flag(flags, "slippage-bps") != null)
    execution.slippageBps = numberFlag(flags, "slippage-bps");
  if (flag(flags, "venue-fee-bps") != null)
    execution.venueFeeBps = numberFlag(flags, "venue-fee-bps");
  if (flag(flags, "network-fee-sol") != null)
    execution.networkFeeSol = numberFlag(flags, "network-fee-sol");
  if (flag(flags, "latency-ms") != null)
    execution.latencyMs = numberFlag(flags, "latency-ms");
  return { ...strategy, execution } as CliStrategy;
}

function targetWeightStrategy(flags: Flags): TargetWeightPolicy {
  const targetWeightPct = numberFlag(flags, "target-weight", 40)!;
  const gapMode = flag(flags, "gap-mode") ?? "fixed";
  if (gapMode !== "fixed" && gapMode !== "previous-5m-vol") {
    throw new Error("--gap-mode must be fixed or previous-5m-vol");
  }
  return {
    version: 1,
    kind: "target-weight",
    name:
      gapMode === "fixed"
        ? `Target weight ${targetWeightPct}% / ${numberFlag(flags, "gap-pct", 3)}pp band`
        : `Target weight ${targetWeightPct}% / adaptive 5m-vol band`,
    targetWeightPct,
    gap: {
      mode: gapMode,
      outerPct: numberFlag(flags, "gap-pct", 3)!,
      innerPct: numberFlag(flags, "inner-gap-pct", 1)!,
      volatilityMultiplier: numberFlag(flags, "vol-multiplier", 2),
      minPct: numberFlag(flags, "min-gap-pct", 1),
      maxPct: numberFlag(flags, "max-gap-pct", 8),
    },
    minTradeSol: numberFlag(flags, "min-trade-sol", 0.001),
    execution: {
      slippageBps: numberFlag(flags, "slippage-bps", 0),
      venueFeeBps: numberFlag(flags, "venue-fee-bps", 0),
      networkFeeSol: numberFlag(flags, "network-fee-sol", 0),
      latencyMs: numberFlag(flags, "latency-ms", 0),
    },
  };
}

function readStrategy(flags: Flags): CliStrategy {
  const requested = flag(flags, "strategy");
  if (requested === "target-weight" || flags.has("target-weight")) {
    return targetWeightStrategy(flags);
  }
  if (requested && requested !== "ath-dip-profit-ladder") {
    const parsed = JSON.parse(
      readFileSync(resolve(requested), "utf8"),
    ) as CliStrategy;
    return applyExecutionOverrides(parsed, flags);
  }

  const dipPct = numberFlag(flags, "dip-pct");
  const profitPct = numberFlag(flags, "profit-pct");
  const buySol = numberFlag(flags, "buy-sol");
  if (dipPct == null || profitPct == null || buySol == null) {
    throw new Error(
      "Usage:\n" +
        "  slrd backtest <mint> --strategy target-weight --target-weight 40 --gap-pct 3 --inner-gap-pct 1 [options]\n" +
        "  slrd backtest <mint> --strategy target-weight --gap-mode previous-5m-vol --vol-multiplier 2 [options]\n" +
        "  slrd backtest <mint> --dip-pct 20 --profit-pct 40 --buy-sol 0.1 [options]\n" +
        "  slrd backtest <mint> --strategy <file.json> [options]",
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

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
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

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function executionLedgerCsv(result: CliBacktestResult): string {
  if (result.strategy.kind === "target-weight") {
    const target = result as TokenTargetWeightBacktestResult;
    const rows = target.executions.map((row) => ({
      at: new Date(row.atMs).toISOString(),
      triggerAt: new Date(row.triggerAtMs).toISOString(),
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
      networkFeeSol: row.networkFeeSol,
      degradationBps: row.degradationBps,
      eventIndex: row.eventIndex,
      eventId: row.eventId,
      signature: row.signature,
      source: row.source,
      confidence: row.confidence,
      reason: row.reason,
    }));
    if (!rows.length) return "";
    const headers = Object.keys(rows[0]!);
    return (
      [
        headers.map(csvCell).join(","),
        ...rows.map((row) =>
          headers.map((key) => csvCell(row[key as keyof typeof row])).join(","),
        ),
      ].join("\n") + "\n"
    );
  }

  const ath = result as TokenAthDipProfitBacktestResult;
  const rows = ath.executions.map((row) => ({
    at: new Date(row.atMs).toISOString(),
    side: row.side,
    status: row.status,
    lotId: row.lotId,
    level: row.level,
    observedPriceSol: row.observedPriceSol,
    executionPriceSol: row.executionPriceSol,
    amountSol: row.amountSol,
    tokens: row.tokens,
    eventIndex: row.eventIndex,
    eventId: row.eventId,
    signature: row.signature,
    source: row.source,
    confidence: row.confidence,
    reason: row.reason,
  }));
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]!);
  return (
    [
      headers.map(csvCell).join(","),
      ...rows.map((row) =>
        headers.map((key) => csvCell(row[key as keyof typeof row])).join(","),
      ),
    ].join("\n") + "\n"
  );
}

function ledgerPath(
  flags: Flags,
  mint: string,
  strategy: CliStrategy,
): string | null {
  if (!flags.has("ledger")) return null;
  const requested = flag(flags, "ledger");
  if (requested) return resolve(requested);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(
    "backtest-results",
    `${mint}-${strategy.kind}-${stamp}-ledger.csv`,
  );
}

function executionCostLine(strategy: CliStrategy): string {
  const execution = strategy.execution ?? {};
  const slippageBps = execution.slippageBps ?? 0;
  const venueFeeBps = execution.venueFeeBps ?? 0;
  const networkFeeSol = execution.networkFeeSol ?? 0;
  const latencyMs = execution.latencyMs ?? 0;
  const none =
    slippageBps === 0 &&
    venueFeeBps === 0 &&
    networkFeeSol === 0 &&
    latencyMs === 0;
  return none
    ? "NONE — gross simulation; no slippage, venue fee, network fee, or latency configured"
    : `slippage=${slippageBps}bps/side venue=${venueFeeBps}bps/side network=${networkFeeSol} SOL/tx latency=${latencyMs}ms`;
}

function commonHeader(
  result: CliBacktestResult,
  window: ReplayWindow,
): string[] {
  const coverage = result.coverage;
  const historyStart = coverage.provenFromCreation
    ? `FROM CREATION (first-trade gap ${coverage.creationGapMs ?? 0}ms)`
    : coverage.status === "unknown"
      ? "UNKNOWN START"
      : `PARTIAL START (first-trade gap ${coverage.creationGapMs ?? "unknown"}ms)`;
  const completeness = coverage.backfillComplete
    ? "COMPLETE"
    : "INCOMPLETE — gaps/truncation/parser skips remain in durable history";
  return [
    "SLRD BACKTEST",
    `Mint: ${result.mint}`,
    `Strategy: ${result.strategy.name ?? result.strategy.kind}`,
    `Tape: ${result.tape.events} usable events (${result.input.sourceRows} ${result.input.source} rows)`,
    `Replay start: ${window.fromLabel}`,
    `Replay end:   ${window.toLabel}`,
    `Actual period: ${result.tape.firstAtMs ? new Date(result.tape.firstAtMs).toISOString() : "n/a"} -> ${result.tape.lastAtMs ? new Date(result.tape.lastAtMs).toISOString() : "n/a"}`,
    `History coverage: ${historyStart}; ${completeness}`,
    `Execution costs: ${executionCostLine(result.strategy)}`,
    `Price sanity: ${result.input.skippedAnomalousPrice > 0 ? `excluded ${result.input.skippedAnomalousPrice} isolated anomalous price event(s)` : "no isolated anomalies detected"}`,
  ];
}

function humanReportAth(
  result: TokenAthDipProfitBacktestResult,
  window: ReplayWindow,
): string {
  const s = result.summary;
  return [
    ...commonHeader(result, window),
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

function humanReportTargetWeight(
  result: TokenTargetWeightBacktestResult,
  window: ReplayWindow,
): string {
  const s = result.summary;
  const strategy = result.strategy;
  return [
    ...commonHeader(result, window),
    `Cadence: ${result.tape.cadenceMs / 60_000}m`,
    `Controller: target=${strategy.targetWeightPct}% gap=${strategy.gap.mode} outer=${strategy.gap.outerPct}pp inner=${strategy.gap.innerPct}pp minTrade=${strategy.minTradeSol ?? 0} SOL`,
    "",
    `Starting capital:        ${fmtSol(s.startingSol)}`,
    `Ending SOL:              ${fmtSol(s.endingSol)}`,
    `Ending tokens:           ${s.endingTokens}`,
    `Final equity:            ${fmtSol(s.finalEquitySol)}`,
    `Net P&L:                 ${fmtSol(s.netPnlSol)} (${fmtPct(s.returnPct)})`,
    `Max drawdown:            ${fmtPct(s.maxDrawdownPct)}`,
    "",
    `Buys / sells:            ${s.buys} / ${s.sells}`,
    `Rebalance signals:       ${s.rebalanceSignals}`,
    `Skipped executions:      ${s.skippedExecutions}`,
    `Decision points:         ${s.decisions}`,
    `Outside band:            ${fmtPct(s.decisionOutsideBandPct)}`,
    `X weight avg/min/max:    ${fmtPct(s.averageWeightPct)} / ${fmtPct(s.minWeightPct)} / ${fmtPct(s.maxWeightPct)}`,
    `Turnover:                ${fmtSol(s.totalTurnoverSol)}`,
    `Network fees:            ${fmtSol(s.totalNetworkFeesSol)}`,
    `Slippage+venue cost:     ${fmtSol(s.totalDegradationCostSol)}`,
    `Total execution cost:    ${fmtSol(s.totalExecutionCostSol)}`,
    "",
    `Benchmark 100% SOL:      ${fmtPct(s.benchmark100SolReturnPct)}`,
    `Benchmark 100% token:    ${fmtPct(s.benchmark100TokenReturnPct)}`,
    `Benchmark initial mix:   ${fmtPct(s.benchmarkInitialMixReturnPct)}`,
    `Excess vs initial mix:   ${fmtPct(s.excessVsInitialMixPct)}`,
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
      "Usage: slrd backtest <mint> --strategy target-weight [options] | --dip-pct ...",
    );
  }
  const strategy = readStrategy(args.flags);
  const window = resolveReplayWindow(mint, args.flags);
  const commonOptions = {
    startingSol: numberFlag(args.flags, "capital-sol", 5),
    fromMs: window.fromMs,
    toMs: window.toMs,
    includeProcessed: !args.flags.has("confirmed-only"),
    coverageToleranceMs: numberFlag(
      args.flags,
      "coverage-tolerance-ms",
      60_000,
    ),
    requireFromCreation: args.flags.has("require-from-start"),
    source: args.flags.has("exact-trades")
      ? ("trades" as const)
      : ("candles-1s" as const),
    priceSanity: !args.flags.has("no-price-sanity"),
    isolatedPriceSpikeRatio: numberFlag(args.flags, "price-spike-ratio", 1000),
    priceContinuityRatio: numberFlag(args.flags, "price-continuity-ratio", 5),
    priceSanityWindow: numberFlag(args.flags, "price-sanity-window", 20),
    priceSanityWindowMs: numberFlag(
      args.flags,
      "price-sanity-window-ms",
      300_000,
    ),
  };

  const result: CliBacktestResult =
    strategy.kind === "target-weight"
      ? backtestTargetWeightToken(mint, strategy, {
          ...commonOptions,
          cadenceMs: parseDurationMs(flag(args.flags, "cadence"), 300_000),
        })
      : backtestTokenTrades(mint, strategy, commonOptions);

  const out = flag(args.flags, "out");
  if (out) {
    const path = resolve(out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${json(result)}\n`);
  }

  const ledger = ledgerPath(args.flags, mint, strategy);
  if (ledger) {
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, executionLedgerCsv(result));
  }

  if (args.flags.has("json")) {
    args.emit(`${json(result)}\n`);
  } else {
    args.emit(
      `${strategy.kind === "target-weight" ? humanReportTargetWeight(result as TokenTargetWeightBacktestResult, window) : humanReportAth(result as TokenAthDipProfitBacktestResult, window)}\n`,
    );
    if (out) args.emit(`Full result: ${resolve(out)}\n`);
    if (ledger)
      args.emit(
        `Execution ledger: ${ledger} (${result.executions.length} rows)\n`,
      );
    if (result.input.priceAnomalies.length) {
      const worst = [...result.input.priceAnomalies].sort(
        (a, b) =>
          Math.max(b.ratioToBefore, b.ratioToAfter) -
          Math.max(a.ratioToBefore, a.ratioToAfter),
      )[0]!;
      args.emit(
        `Price anomaly example: ${new Date(worst.atMs).toISOString()} price=${worst.priceSol} ` +
          `neighbors≈${worst.beforeMedianSol}/${worst.afterMedianSol} signature=${worst.signature}\n`,
      );
    }
  }
}
