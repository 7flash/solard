#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  backfillRaydiumTokenHistory,
  backfillTokenHistory,
  backtestTargetWeightToken,
  backtestTokenTrades,
  createTraderSolard,
  getTokenHistoryCoverage,
  loadTokenBacktestTape,
  loadTokenHistoryTrades,
  quoteJupiterSwap,
  TokenHistoryError,
} from "@solard/core";
import { simulateValueBandStrategy } from "../packages/core/src/backtest/value-band-sim.ts";

const WSOL = "So11111111111111111111111111111111111111112";
type Flags = Map<string, string>;

type Trade = ReturnType<typeof loadTokenHistoryTrades>[number];

type InitialParticipant = {
  owner: string;
  firstAtMs: number;
  firstSide: "buy" | "sell";
  firstDeltaMs: number;
  buySol: number;
  sellSol: number;
  boughtTokens: number;
  soldTokens: number;
  trades: number;
  soldBeforeRecordedBuy: boolean;
};

function parse(argv: string[]): Flags {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]!;
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    if (inline != null) out.set(key!, inline);
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--"))
      out.set(key!, argv[++i]!);
    else out.set(key!, "true");
  }
  return out;
}
function flag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}
function required(flags: Flags, key: string): string {
  const value = flag(flags, key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}
function numberFlag(flags: Flags, key: string, fallback: number): number {
  const value = Number(flag(flags, key) ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`Invalid --${key}`);
  return value;
}
function pct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}
function short(value: string, head = 6, tail = 5): string {
  return value.length <= head + tail + 1
    ? value
    : `${value.slice(0, head)}…${value.slice(-tail)}`;
}
function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}
function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]!);
  const quote = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return (
    keys.join(",") +
    "\n" +
    rows.map((row) => keys.map((key) => quote(row[key])).join(",")).join("\n") +
    "\n"
  );
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const rows = [...values].sort((a, b) => a - b);
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2
    ? rows[middle]!
    : (rows[middle - 1]! + rows[middle]!) / 2;
}

/** Same price fallback used by Solard's durable backtest tape. */
function canonicalTradePrice(trade: Trade): number | null {
  const explicit = Number(trade.priceSol);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const token = Math.abs(Number(trade.tokenDeltaUi));
  const sol = Math.abs(Number(trade.solDeltaUi));
  return Number.isFinite(token) && token > 0 && Number.isFinite(sol) && sol > 0
    ? sol / token
    : null;
}

function empiricalFriction(trades: Trade[]) {
  const buckets = new Map<number, { buys: number[]; sells: number[] }>();
  for (const trade of trades) {
    const price = canonicalTradePrice(trade);
    if (price == null) continue;
    const second = Math.floor(trade.tradedAtMs / 1_000);
    const row = buckets.get(second) ?? { buys: [], sells: [] };
    row[trade.side === "buy" ? "buys" : "sells"].push(price);
    buckets.set(second, row);
  }
  const ratios: number[] = [];
  for (const row of buckets.values()) {
    const buy = median(row.buys);
    const sell = median(row.sells);
    if (buy && sell && buy >= sell) ratios.push(buy / sell - 1);
  }
  const roundTrip = median(ratios);
  return {
    pairedSeconds: ratios.length,
    medianRoundTripPct: roundTrip == null ? null : roundTrip * 100,
    approxOneWayBps:
      roundTrip == null ? null : (Math.sqrt(1 + roundTrip) - 1) * 10_000,
  };
}

function initialAnalysis(
  tradesInput: Trade[],
  creationAtMs: number | null,
  windowMs: number,
) {
  const trades = [...tradesInput].sort(
    (a, b) => a.tradedAtMs - b.tradedAtMs || a.slot - b.slot,
  );
  const anchorAtMs = creationAtMs ?? trades[0]?.tradedAtMs ?? null;
  if (anchorAtMs == null) {
    return {
      anchorAtMs: null,
      windowMs,
      participants: [],
      sellBeforeBuy: [],
      clusters: [],
      concentration: null,
      flow: [],
    };
  }
  const early = trades.filter((row) => row.tradedAtMs <= anchorAtMs + windowMs);
  const participants = new Map<string, InitialParticipant>();
  const priorBoughtTokens = new Map<string, number>();
  const sellBeforeBuyOwners = new Set<string>();

  for (const trade of trades) {
    if (!trade.owner) continue;
    const owner = trade.owner;
    const boughtBefore = priorBoughtTokens.get(owner) ?? 0;
    if (trade.side === "sell" && boughtBefore <= 1e-12)
      sellBeforeBuyOwners.add(owner);
    if (trade.side === "buy")
      priorBoughtTokens.set(
        owner,
        boughtBefore + Math.abs(Number(trade.tokenDeltaUi)),
      );
    else
      priorBoughtTokens.set(
        owner,
        Math.max(0, boughtBefore - Math.abs(Number(trade.tokenDeltaUi))),
      );

    if (trade.tradedAtMs > anchorAtMs + windowMs) continue;
    const row = participants.get(owner) ?? {
      owner,
      firstAtMs: trade.tradedAtMs,
      firstSide: trade.side,
      firstDeltaMs: Math.max(0, trade.tradedAtMs - anchorAtMs),
      buySol: 0,
      sellSol: 0,
      boughtTokens: 0,
      soldTokens: 0,
      trades: 0,
      soldBeforeRecordedBuy: false,
    };
    if (trade.side === "buy") {
      row.buySol += Math.abs(Number(trade.solDeltaUi));
      row.boughtTokens += Math.abs(Number(trade.tokenDeltaUi));
    } else {
      row.sellSol += Math.abs(Number(trade.solDeltaUi));
      row.soldTokens += Math.abs(Number(trade.tokenDeltaUi));
    }
    row.trades += 1;
    row.soldBeforeRecordedBuy ||= sellBeforeBuyOwners.has(owner);
    participants.set(owner, row);
  }

  const participantRows = [...participants.values()].sort(
    (a, b) => a.firstAtMs - b.firstAtMs || b.buySol - a.buySol,
  );
  const buyers = participantRows
    .filter((row) => row.buySol > 0)
    .sort((a, b) => b.buySol - a.buySol);
  const totalBuySol = buyers.reduce((sum, row) => sum + row.buySol, 0);
  const share = (count: number) =>
    totalBuySol > 0
      ? (buyers.slice(0, count).reduce((sum, row) => sum + row.buySol, 0) /
          totalBuySol) *
        100
      : 0;

  const clusters: Array<Record<string, unknown>> = [];
  const signatureGroups = new Map<string, Trade[]>();
  const slotGroups = new Map<number, Trade[]>();
  for (const trade of early.filter((row) => row.side === "buy" && row.owner)) {
    const sig = signatureGroups.get(trade.signature) ?? [];
    sig.push(trade);
    signatureGroups.set(trade.signature, sig);
    const slot = slotGroups.get(trade.slot) ?? [];
    slot.push(trade);
    slotGroups.set(trade.slot, slot);
  }
  for (const [signature, rows] of signatureGroups) {
    const owners = [...new Set(rows.map((row) => row.owner!).filter(Boolean))];
    if (owners.length >= 2)
      clusters.push({
        classification: "bundle-like:same-signature",
        signature,
        slot: rows[0]!.slot,
        owners,
        buySol: rows.reduce(
          (sum, row) => sum + Math.abs(Number(row.solDeltaUi)),
          0,
        ),
      });
  }
  for (const [slot, rows] of slotGroups) {
    const owners = [...new Set(rows.map((row) => row.owner!).filter(Boolean))];
    if (owners.length >= 2 && !clusters.some((row) => row.slot === slot)) {
      clusters.push({
        classification: "bundle-like:same-slot",
        signature: null,
        slot,
        owners,
        buySol: rows.reduce(
          (sum, row) => sum + Math.abs(Number(row.solDeltaUi)),
          0,
        ),
      });
    }
  }

  const flowWindows = [
    [0, 5_000, "0-5s"],
    [5_000, 15_000, "5-15s"],
    [15_000, 30_000, "15-30s"],
    [30_000, 60_000, "30-60s"],
    [60_000, 300_000, "1-5m"],
  ] as const;
  const flow = flowWindows.map(([from, to, label]) => {
    const rows = trades.filter(
      (row) =>
        row.tradedAtMs >= anchorAtMs + from && row.tradedAtMs < anchorAtMs + to,
    );
    const buySol = rows
      .filter((row) => row.side === "buy")
      .reduce((sum, row) => sum + Math.abs(Number(row.solDeltaUi)), 0);
    const sellSol = rows
      .filter((row) => row.side === "sell")
      .reduce((sum, row) => sum + Math.abs(Number(row.solDeltaUi)), 0);
    return {
      label,
      buySol,
      sellSol,
      netSol: buySol - sellSol,
      trades: rows.length,
    };
  });

  return {
    anchorAtMs,
    windowMs,
    participants: participantRows,
    sellBeforeBuy: participantRows
      .filter((row) => row.soldBeforeRecordedBuy && row.sellSol > 0)
      .sort((a, b) => b.sellSol - a.sellSol),
    clusters,
    concentration: {
      earlyBuyers: buyers.length,
      totalBuySol,
      top1BuySolPct: share(1),
      top5BuySolPct: share(5),
      top10BuySolPct: share(10),
    },
    flow,
  };
}

async function currentRoundTrip(mint: string, solAmount: number) {
  const inputRaw = BigInt(Math.max(1, Math.round(solAmount * 1e9)));
  const buy = await quoteJupiterSwap({
    inputMint: WSOL,
    outputMint: mint,
    amountRaw: inputRaw,
  });
  const sell = await quoteJupiterSwap({
    inputMint: mint,
    outputMint: WSOL,
    amountRaw: buy.outAmountRaw,
  });
  const outputSol = Number(sell.outAmountRaw) / 1e9;
  return {
    inputSol: solAmount,
    tokensRaw: buy.outAmountRaw.toString(),
    roundTripSol: outputSol,
    lossPct: (1 - outputSol / solAmount) * 100,
    buyRouter: (buy as any).router ?? null,
    sellRouter: (sell as any).router ?? null,
  };
}

export async function runTokenResearch(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const flags = parse(argv);
  const mint = flag(flags, "mint") ?? required(flags, "token");
  const capital = numberFlag(flags, "capital-sol", 1);
  const base = numberFlag(flags, "base-sol", 0.1);
  const maxCapital = numberFlag(
    flags,
    "max-capital-sol",
    Math.max(base * 5, capital),
  );
  const outDir = resolve(
    flag(flags, "out") ??
      `.solard/research/${mint}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  mkdirSync(outDir, { recursive: true });

  const slrd = createTraderSolard();
  try {
    if (!flags.has("no-backfill")) {
      try {
        await backfillTokenHistory(slrd.connection(), mint, {
          replace: flags.has("replace"),
        });
      } catch (error) {
        if (
          !(error instanceof TokenHistoryError) ||
          error.code !== "UNSUPPORTED_TOKEN"
        )
          throw error;
        process.stdout.write(
          "Pump history unsupported; trying Raydium/LaunchLab history.\n",
        );
        await backfillRaydiumTokenHistory(slrd.connection(), mint, {
          replace: flags.has("replace"),
          maxRaydiumPools: Math.max(
            1,
            Math.trunc(numberFlag(flags, "raydium-pools", 8)),
          ),
        });
      }
    }

    const trades = loadTokenHistoryTrades(mint);
    if (trades.length < 2)
      throw new Error("No durable history. Run token backfill first.");
    const coverage = getTokenHistoryCoverage(mint);

    // IMPORTANT: use Solard's canonical durable tape, not row.priceSol directly.
    // Pump curve rows can have priceSol=null while still containing exact economic
    // SOL/token deltas. loadTokenBacktestTape applies that fallback consistently.
    const replay = loadTokenBacktestTape(mint, { source: "trades" });
    if (replay.events.length < 2) {
      throw new Error(
        `Durable history has ${trades.length} trades but only ${replay.events.length} replayable prices ` +
          `(skippedNoPrice=${replay.skippedNoPrice}).`,
      );
    }
    const tape = replay.events.map((event) => ({
      atMs: event.tradedAtMs,
      priceSol: Number(event.priceSol),
      id: event.id,
    }));

    const initial = initialAnalysis(
      trades,
      coverage?.creationAtMs ?? null,
      Math.max(
        1_000,
        Math.trunc(numberFlag(flags, "initial-window-sec", 60) * 1_000),
      ),
    );
    const friction = empiricalFriction(trades);

    process.stdout.write(`TOKEN RESEARCH\nMint: ${mint}\n`);
    process.stdout.write(
      `Coverage: ${coverage?.complete && coverage?.fromCreation ? "COMPLETE FROM CREATION" : "PARTIAL"}\n`,
    );
    process.stdout.write(
      `Trades: ${trades.length}; replayable prices: ${replay.events.length}; skipped-no-price: ${replay.skippedNoPrice}\n\n`,
    );
    process.stdout.write(`INITIAL ${Math.round(initial.windowMs / 1000)}s\n`);
    if (initial.concentration) {
      process.stdout.write(
        `buyers=${initial.concentration.earlyBuyers} buy=${initial.concentration.totalBuySol.toFixed(6)} SOL ` +
          `top1=${initial.concentration.top1BuySolPct.toFixed(1)}% top5=${initial.concentration.top5BuySolPct.toFixed(1)}%\n`,
      );
    }
    for (const row of initial.flow) {
      process.stdout.write(
        `${row.label.padEnd(7)} buy=${row.buySol.toFixed(6)} sell=${row.sellSol.toFixed(6)} net=${row.netSol >= 0 ? "+" : ""}${row.netSol.toFixed(6)} SOL\n`,
      );
    }
    if (initial.sellBeforeBuy.length) {
      process.stdout.write(
        "\nSELL-BEFORE-RECORDED-BUY (initial inventory / transfer origin to inspect)\n",
      );
      for (const row of initial.sellBeforeBuy.slice(0, 10)) {
        process.stdout.write(
          `${short(row.owner).padEnd(14)} first=+${(row.firstDeltaMs / 1000).toFixed(1)}s ` +
            `sold=${row.sellSol.toFixed(6)} SOL bought=${row.buySol.toFixed(6)} SOL\n`,
        );
      }
    }
    process.stdout.write(
      `\nBundle-like early clusters: ${initial.clusters.length} (heuristic, not proof of common control)\n\n`,
    );

    const first = tape[0]!;
    const last = tape.at(-1)!;
    const holdTokens = base / first.priceSol;
    const holdFinal = capital - base + holdTokens * last.priceSol;
    const holdReturn = (holdFinal / capital - 1) * 100;

    const explicitExecutionBps = flag(flags, "execution-bps");
    const executionBps =
      explicitExecutionBps != null
        ? Math.max(0, Number(explicitExecutionBps))
        : flags.has("use-empirical-friction")
          ? Math.max(0, friction.approxOneWayBps ?? 0)
          : 0;
    const networkFeeSol = numberFlag(flags, "network-fee-sol", 0.00001);

    const variants = ["same-value", "to-base", "same-tokens"].map((mode) => ({
      mode,
      result: simulateValueBandStrategy(
        tape,
        {
          version: 1,
          kind: "value-band",
          baseSol: base,
          lowerMultiple: numberFlag(flags, "lower-multiple", 0.5),
          upperMultiple: numberFlag(flags, "upper-multiple", 1.8),
          sellFraction: numberFlag(flags, "sell-fraction", 0.5),
          buyMode: mode as any,
          minTradeSol: numberFlag(flags, "min-trade-sol", 0.001),
          maxCapitalDeployedSol: maxCapital,
        },
        { startingSol: capital, executionBps, networkFeeSol },
      ),
    }));

    const summary: Array<Record<string, any>> = [
      {
        id: `hold-${base}-SOL-sleeve`,
        returnPct: holdReturn,
        finalEquitySol: holdFinal,
        maxDrawdownPct: null,
        trades: 1,
        peakCapitalSol: base,
      },
      ...variants.map((variant) => ({
        id: `value-band-${variant.mode}`,
        returnPct: variant.result.summary.returnPct,
        finalEquitySol: variant.result.summary.finalEquitySol,
        maxDrawdownPct: variant.result.summary.maxDrawdownPct,
        trades: variant.result.summary.buys + variant.result.summary.sells,
        peakCapitalSol: variant.result.summary.peakNetCapitalDeployedSol,
      })),
    ];

    if (!flags.has("no-legacy")) {
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
            networkFeeSol,
            latencyMs: 0,
          },
        },
        { startingSol: capital, requireFromCreation: false, source: "trades" },
      );
      summary.push({
        id: "legacy-ath-dip-tp",
        returnPct: legacy.summary.returnPct,
        finalEquitySol: legacy.summary.finalEquitySol,
        maxDrawdownPct: legacy.summary.maxDrawdownPct,
        trades: legacy.summary.buys + legacy.summary.sells,
        peakCapitalSol: null,
      });
    }

    if (flags.has("include-weight") || flags.has("all")) {
      const weight = backtestTargetWeightToken(
        mint,
        {
          version: 1,
          kind: "target-weight",
          targetWeightPct: numberFlag(flags, "target-weight", 40),
          gap: {
            mode: "fixed",
            outerPct: numberFlag(flags, "gap-pct", 3),
            innerPct: numberFlag(flags, "inner-gap-pct", 1),
          },
          minTradeSol: numberFlag(flags, "min-trade-sol", 0.001),
          execution: {
            slippageBps: executionBps,
            venueFeeBps: 0,
            networkFeeSol,
            latencyMs: 0,
          },
        },
        { startingSol: capital, requireFromCreation: false, source: "trades" },
      );
      summary.push({
        id: "weight-band-optional-benchmark",
        returnPct: weight.summary.returnPct,
        finalEquitySol: weight.summary.finalEquitySol,
        maxDrawdownPct: weight.summary.maxDrawdownPct,
        trades: weight.summary.buys + weight.summary.sells,
        peakCapitalSol: null,
      });
    }

    summary.sort((a, b) => Number(b.returnPct) - Number(a.returnPct));

    const currentRoundTrips: any[] = [];
    if (!flags.has("no-probe")) {
      for (const amount of [0.01, 0.05, 0.1]) {
        try {
          currentRoundTrips.push(await currentRoundTrip(mint, amount));
        } catch (error) {
          currentRoundTrips.push({
            inputSol: amount,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const report = {
      mint,
      coverage,
      replay: {
        sourceRows: replay.sourceRows,
        usableRows: replay.usableRows,
        skippedNoPrice: replay.skippedNoPrice,
        skippedAnomalousPrice: replay.skippedAnomalousPrice,
        firstAt: new Date(first.atMs).toISOString(),
        lastAt: new Date(last.atMs).toISOString(),
      },
      friction: {
        empirical: friction,
        simulationOneWayBps: executionBps,
        currentRoundTrips,
      },
      initial,
      summary,
    };

    writeFileSync(resolve(outDir, "report.json"), json(report));
    writeFileSync(resolve(outDir, "comparison.csv"), csv(summary));
    writeFileSync(
      resolve(outDir, "initial-participants.csv"),
      csv(initial.participants as any),
    );
    writeFileSync(
      resolve(outDir, "sell-before-buy.csv"),
      csv(initial.sellBeforeBuy as any),
    );
    writeFileSync(
      resolve(outDir, "bundle-like-clusters.json"),
      json(initial.clusters),
    );
    for (const variant of variants) {
      writeFileSync(
        resolve(outDir, `ledger-value-band-${variant.mode}.csv`),
        csv(variant.result.executions as any),
      );
    }

    process.stdout.write(`Results: ${outDir}\n`);
    process.stdout.write(
      `Simulation friction: ${executionBps.toFixed(1)} bps/side${explicitExecutionBps == null && !flags.has("use-empirical-friction") ? " (baseline; no extra slippage)" : ""}\n\n`,
    );
    process.stdout.write(
      "RANK  STRATEGY                              RETURN     FINAL SOL   MAX DD  TRADES  PEAK CAPITAL\n",
    );
    summary.forEach((row, index) => {
      process.stdout.write(
        `${String(index + 1).padStart(4)}  ${String(row.id).padEnd(36)} ${pct(Number(row.returnPct)).padStart(9)}  ` +
          `${Number(row.finalEquitySol).toFixed(6).padStart(10)}  ` +
          `${(row.maxDrawdownPct == null ? "-" : pct(Number(row.maxDrawdownPct))).padStart(7)}  ` +
          `${String(row.trades).padStart(6)}  ` +
          `${(row.peakCapitalSol == null ? "-" : Number(row.peakCapitalSol).toFixed(4)).padStart(12)}\n`,
      );
    });
  } finally {
    slrd.close();
  }
}

if (import.meta.main) {
  runTokenResearch().catch((error) => {
    process.stderr.write(
      `RESEARCH ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
