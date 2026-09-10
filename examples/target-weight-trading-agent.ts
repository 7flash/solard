#!/usr/bin/env bun
import {
  configureSolardMeasure,
  createSolardMeasure,
  createTraderSolard,
  planTargetWeightRebalance,
  sol,
  type MarketPrice,
  type TargetWeightCandle,
  type TargetWeightPolicy,
} from "@solard/sdk";

const FIVE_MINUTES_MS = 300_000;
const m = createSolardMeasure("target-weight-agent");
type Flags = Map<string, string>;

type SampleCandle = TargetWeightCandle & {
  firstSampleAtMs: number;
  lastSampleAtMs: number;
  samples: number;
};

function parseArgs(argv: string[]): Flags {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]!;
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
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
  const raw = flag(flags, key);
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${raw}`);
  return parsed;
}

function integerFlag(flags: Flags, key: string, fallback: number): number {
  return Math.trunc(numberFlag(flags, key, fallback));
}

function liveEnabled(): boolean {
  return [
    process.env.SOLARD_ENABLE_LIVE_TRADES,
    process.env.SLRD_ENABLE_LIVE_TRADES,
    process.env.SOLWAL_ENABLE_LIVE_TRADES,
  ].some((value) => value === "1" || value === "true");
}

function short(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function policy(flags: Flags): TargetWeightPolicy {
  const mode = flag(flags, "gap-mode") ?? "fixed";
  if (mode !== "fixed" && mode !== "previous-5m-vol")
    throw new Error("--gap-mode must be fixed or previous-5m-vol");
  return {
    version: 1,
    kind: "target-weight",
    name: "live target-weight controller",
    targetWeightPct: numberFlag(flags, "target-weight", 40),
    gap: {
      mode,
      outerPct: numberFlag(flags, "gap-pct", 3),
      innerPct: numberFlag(flags, "inner-gap-pct", 1),
      volatilityMultiplier: numberFlag(flags, "vol-multiplier", 2),
      minPct: numberFlag(flags, "min-gap-pct", 1),
      maxPct: numberFlag(flags, "max-gap-pct", 8),
    },
    minTradeSol: numberFlag(flags, "min-trade-sol", 0.01),
    execution: {
      slippageBps: integerFlag(flags, "slippage-bps", 150),
      venueFeeBps: numberFlag(flags, "planning-venue-fee-bps", 0),
      networkFeeSol: numberFlag(flags, "planning-network-fee-sol", 0.00001),
      latencyMs: 0,
    },
  };
}

function addSample(
  candles: Map<number, SampleCandle>,
  atMs: number,
  price: number,
): void {
  const startMs = Math.floor(atMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  const existing = candles.get(startMs);
  if (!existing) {
    candles.set(startMs, {
      startMs,
      endMs: startMs + FIVE_MINUTES_MS,
      open: price,
      high: price,
      low: price,
      close: price,
      firstSampleAtMs: atMs,
      lastSampleAtMs: atMs,
      samples: 1,
    });
    return;
  }
  existing.high = Math.max(existing.high, price);
  existing.low = Math.min(existing.low, price);
  existing.close = price;
  existing.lastSampleAtMs = atMs;
  existing.samples += 1;
}

function completePreviousCandle(
  candles: Map<number, SampleCandle>,
  boundaryMs: number,
  sampleMs: number,
): SampleCandle | null {
  const candle = candles.get(boundaryMs - FIVE_MINUTES_MS) ?? null;
  if (!candle) return null;
  const tolerance = Math.max(sampleMs * 2, 10_000);
  return candle.firstSampleAtMs <= candle.startMs! + tolerance &&
    candle.lastSampleAtMs >= candle.endMs! - tolerance
    ? candle
    : null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.has("help")) {
    console.log(
      "Usage: bun run slrd run examples/target-weight-trading-agent.ts --token <mint|alias> --wallet <wallet> " +
        "[--target-weight 40] [--gap-pct 3] [--inner-gap-pct 1] " +
        "[--gap-mode fixed|previous-5m-vol] [--reserve-sol 0.02] [--loop] [--live]",
    );
    return;
  }

  configureSolardMeasure({ silent: false });
  const tokenRef = required(flags, "token");
  const walletRef = required(flags, "wallet");
  const strategy = policy(flags);
  const reserveSol = Math.max(0, numberFlag(flags, "reserve-sol", 0.02));
  const sampleMs = Math.max(1_000, integerFlag(flags, "sample-ms", 5_000));
  const settleMs = Math.max(0, integerFlag(flags, "settle-ms", 5_000));
  const via = flag(flags, "sender") ?? "rpc";
  const live = flags.has("live");
  if (live && !liveEnabled()) {
    throw new Error(
      "Live target-weight trading requires --live and SOLARD_ENABLE_LIVE_TRADES=1",
    );
  }

  const slrd = createTraderSolard();
  const token = slrd.resolveToken(tokenRef);
  const wallet = slrd.resolveWallet(walletRef).address.toBase58();
  const candles = new Map<number, SampleCandle>();

  await m(
    {
      start: () => "strategy policy",
      end: (value: unknown) => value,
    },
    async () => ({
      token: short(token.mint),
      wallet: short(wallet),
      live,
      targetWeightPct: strategy.targetWeightPct,
      gap: strategy.gap,
      minTradeSol: strategy.minTradeSol,
      reserveSol,
      sampleMs,
    }),
  );

  let nextBoundary =
    (Math.floor(Date.now() / FIVE_MINUTES_MS) + 1) * FIVE_MINUTES_MS;
  while (true) {
    let sampled: MarketPrice;
    try {
      sampled = await m(
        {
          start: () => "sample X/SOL price",
          end: (value: MarketPrice) => ({
            venue: value.venue,
            priceSol: value.priceQuotePerToken,
          }),
        },
        () => slrd.samplePrice(token),
      );
      if (
        sampled.quoteAsset.kind !== "native-sol" &&
        sampled.quoteAsset.mint.toBase58() !==
          "So11111111111111111111111111111111111111112"
      ) {
        throw new Error(
          `Target-weight X/SOL agent requires a SOL quote; venue ${sampled.venue} quoted ${sampled.quoteAsset.mint.toBase58()}`,
        );
      }
      addSample(
        candles,
        sampled.capturedAtMs || Date.now(),
        sampled.priceQuotePerToken,
      );
    } catch (error) {
      await m(
        {
          start: () => "recoverable price sample failure",
          end: (value: unknown) => value,
        },
        async () => ({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      if (!flags.has("loop")) throw error;
      await sleep(sampleMs);
      continue;
    }

    const now = Date.now();
    if (now >= nextBoundary + settleMs) {
      const boundary = nextBoundary;
      nextBoundary += FIVE_MINUTES_MS;
      const previousCandle = completePreviousCandle(
        candles,
        boundary,
        sampleMs,
      );
      try {
        await m(
          {
            start: () => `rebalance ${new Date(boundary).toISOString()}`,
            end: (value: unknown) => value,
          },
          async () => {
            if (strategy.gap.mode === "previous-5m-vol" && !previousCandle) {
              return {
                action: "hold",
                reason: "waiting for one complete locally sampled 5m candle",
              };
            }
            const snapshot = await slrd.walletBalances(walletRef, [token]);
            const row = snapshot.tokenBalances[0]!;
            const tokenAmount = Number(row.amountRaw) / 10 ** row.decimals;
            const walletSol = Number(snapshot.solLamports) / 1e9;
            const strategySol = Math.max(0, walletSol - reserveSol);
            const freshPrice = await slrd.samplePrice(token);
            const plan = planTargetWeightRebalance({
              policy: strategy,
              tokenAmount,
              solAmount: strategySol,
              priceSol: freshPrice.priceQuotePerToken,
              previousCandle,
            });
            const summary = {
              action: plan.action,
              currentWeightPct: plan.currentWeightPct,
              targetWeightPct: plan.targetWeightPct,
              desiredWeightPct: plan.desiredWeightPct,
              outerGapPct: plan.outerGapPct,
              tokenAmount,
              strategySol,
              priceSol: freshPrice.priceQuotePerToken,
              buySol: plan.buySol,
              sellBps: plan.sellBps,
              reason: plan.reason,
              candle: previousCandle
                ? `${new Date(previousCandle.startMs!).toISOString()}..${new Date(previousCandle.endMs!).toISOString()}`
                : null,
            };
            if (!live || plan.action === "hold") return summary;
            if (plan.action === "buy") {
              const receipt = await slrd.buy(
                token,
                walletRef,
                sol(plan.buySol),
                {
                  slippageBps: strategy.execution?.slippageBps,
                  via,
                },
              );
              return { ...summary, receipt };
            }
            const receipt = await slrd.sell(token, walletRef, {
              bps: plan.sellBps,
              slippageBps: strategy.execution?.slippageBps,
              via,
            });
            return { ...summary, receipt };
          },
        );
      } catch (error) {
        await m(
          {
            start: () => "recoverable rebalance failure",
            end: (value: unknown) => value,
          },
          async () => ({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        if (!flags.has("loop") || flags.has("fail-fast")) throw error;
      }
      if (!flags.has("loop")) return;
    }

    if (!flags.has("loop")) {
      // One-shot mode evaluates at the next closed 5m boundary so it cannot use
      // a forming candle as volatility input.
      await sleep(Math.max(0, nextBoundary + settleMs - Date.now()));
      continue;
    }
    const staleBefore = Date.now() - FIVE_MINUTES_MS * 3;
    for (const key of candles.keys())
      if (key < staleBefore) candles.delete(key);
    await sleep(
      Math.min(sampleMs, Math.max(250, nextBoundary + settleMs - Date.now())),
    );
  }
}

main().catch((error) => {
  console.error("TARGET-WEIGHT AGENT ERROR", error);
  process.exitCode = 1;
});
