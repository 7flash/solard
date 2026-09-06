#!/usr/bin/env bun
import { backtestTokenTrades, type AthDipProfitStrategy } from "@solard/sdk";

function parseArgs(argv: string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i]!;
    if (!current.startsWith("--")) continue;
    const [key, inline] = current.slice(2).split("=", 2);
    if (inline != null) flags.set(key!, inline);
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
      flags.set(key!, argv[++i]!);
    } else flags.set(key!, "true");
  }
  return flags;
}

function numberFlag(flags: Map<string, string>, key: string, fallback: number) {
  const value = flags.get(key);
  if (!value || value === "true") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${value}`);
  return parsed;
}

const flags = parseArgs(process.argv.slice(2));
const mint = flags.get("mint");
if (!mint || mint === "true") {
  throw new Error(
    "Usage: slrd run .\\strategies\\history\\dip20-tp40.ts --mint <CA> [--capital-sol 5] [--ledger] [--allow-partial]",
  );
}

// Edit this object to define the strategy. By default the simulator replays
// the durable sparse 1-second candle tape. Pass --exact-trades for fill-level
// replay from tokenHistoryTradesV1.
const strategy: AthDipProfitStrategy = {
  version: 1,
  kind: "ath-dip-profit-ladder",
  name: "20% ATH dip / +40% per-lot TP",
  metric: "priceSol",
  entry: {
    stepPct: 20,
    buySol: 0.1,
    catchUpLevels: true,
  },
  exit: {
    profitPct: 40,
  },
  execution: {
    slippageBps: 500,
    venueFeeBps: 0,
    networkFeeSol: 0.00001,
    latencyMs: 500,
  },
};

const result = backtestTokenTrades(mint, strategy, {
  startingSol: numberFlag(flags, "capital-sol", 5),
  requireFromCreation: !flags.has("allow-partial"),
  includeProcessed: false,
  source: flags.has("exact-trades") ? "trades" : "candles-1s",
});

const s = result.summary;
console.log("SLRD SCRIPT BACKTEST");
console.log(`Mint:          ${result.mint}`);
console.log(`Strategy:      ${result.strategy.name}`);
console.log(
  `Coverage:      ${result.coverage.provenFromCreation && result.coverage.backfillComplete ? "COMPLETE FROM CREATION" : result.coverage.status}`,
);
console.log(`Tape source:   ${result.input.source}`);
console.log(`Events:        ${result.tape.events}`);
console.log(`Starting SOL:  ${s.startingSol.toFixed(6)}`);
console.log(`Final equity:  ${s.finalEquitySol.toFixed(6)} SOL`);
console.log(
  `Net P&L:       ${s.netPnlSol.toFixed(6)} SOL (${s.returnPct.toFixed(2)}%)`,
);
console.log(`Max drawdown:  ${s.maxDrawdownPct.toFixed(2)}%`);
console.log(`Buys/sells:    ${s.buys}/${s.sells}`);
console.log(`Closed/open:   ${s.closedLots}/${s.openLots}`);
console.log(
  `Win rate:      ${s.winRatePct == null ? "n/a" : `${s.winRatePct.toFixed(2)}%`}`,
);

if (flags.has("ledger")) {
  console.log("\nEXECUTION LEDGER");
  for (const row of result.executions) {
    console.log(
      `${new Date(row.atMs).toISOString()} ${row.side.toUpperCase().padEnd(4)} ${row.status.padEnd(7)} ` +
        `lot=${row.lotId ?? "-"} level=${row.level ?? "-"} observed=${row.observedPriceSol} ` +
        `${row.executionPriceSol == null ? "" : `fill=${row.executionPriceSol}`} ${row.reason ?? ""}`,
    );
  }
}
