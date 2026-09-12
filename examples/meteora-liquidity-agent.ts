#!/usr/bin/env bun
import { configure, createMeasure } from "measure-fn";
import {
  createTraderSolard,
  type MeteoraPoolSearchResult,
  type MeteoraPositionSnapshot,
  type MeteoraStrategy,
  type Solard,
} from "@solard/sdk";

const WSOL = "So11111111111111111111111111111111111111112";
const FIVE_MINUTES_MS = 5 * 60_000;
const FIVE_MINUTES_SECONDS = 5 * 60;
const m = createMeasure("slrd:lp-agent", { maxResultLength: 1600 });
const AGENT_POLICY_VERSION = 14;
const DEFAULT_MAX_BREAKOUT_BINS = 50;

type Flags = Map<string, string>;
type Inventory = "x-only" | "y-only" | "mixed" | "empty";

type Target = {
  pool: string;
  candleTimestamp: number;
  candleEndTimestamp: number;
  candleLow: number;
  candleHigh: number;
  candleClose: number;
  candleVolume: number;
  activeBin: number;
  activePriceYPerX: number;
  candleMinBinId: number;
  candleMaxBinId: number;
  breakoutBins: number;
};

type RuntimeState = {
  managedPosition: string | null;
  bootstrapUsed: boolean;
  lastCompletedCandleTimestamp: number | null;
};

type ResolvedPool = {
  pool: string;
  source: "pool" | "token";
  token: string | null;
  tokenX: string | null;
  tokenY: string | null;
  tvl: number | null;
  volume24h: number | null;
  matches: number;
};

type CycleResult = {
  action:
    | "open"
    | "would-open"
    | "move"
    | "would-move"
    | "keep"
    | "no-position"
    | "skip";
  pool: string;
  position: string | null;
  targetPosition?: string | null;
  currentRange?: string | null;
  targetRange: string;
  activeBin: number;
  candle: string;
  shiftBins?: number | null;
  inventory?: Inventory;
  reason?: string;
  signatures?: string[];
};

function parseArgs(argv: string[]): Flags {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) continue;
    const [key, inline] = item.slice(2).split("=", 2);
    if (inline != null) {
      flags.set(key!, inline);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key!, next);
      index += 1;
    } else {
      flags.set(key!, "true");
    }
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

function integer(flags: Flags, key: string, fallback: number): number {
  const raw = flag(flags, key);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`--${key} must be an integer`);
  return value;
}

function optionalInteger(flags: Flags, key: string): number | undefined {
  const raw = flag(flags, key);
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`--${key} must be an integer`);
  return value;
}

function uiPositive(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be greater than zero`);
  }
  return value;
}

function uiToRaw(value: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error(`Invalid token decimals: ${decimals}`);
  }
  const text = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    throw new Error(`Invalid decimal amount: ${value}`);
  }
  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) {
    throw new Error(`Amount ${value} has more than ${decimals} decimal places`);
  }
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.slice(0, decimals).padEnd(decimals, "0") || "0")
  ).toString();
}

function positiveDelta(after: unknown, before: unknown): bigint {
  const a = raw(after);
  const b = raw(before);
  return a > b ? a - b : 0n;
}

function resultSignatures(error: unknown): string[] {
  const result = (error as any)?.result;
  return Array.isArray(result?.signatures)
    ? result.signatures.map(String).filter(Boolean)
    : [];
}

function retryableCycleError(error: unknown): boolean {
  if ((error as any)?.retryable === true) return true;
  const code = String((error as any)?.code ?? "");
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "PARTIAL_EXECUTION" ||
    /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|network|fetch|429|502|503|504|not confirmed|confirmation.*timeout|exact previous 5m bucket/i.test(
      message,
    )
  );
}

async function waitForBootstrapOutputBalance(args: {
  slrd: Solard;
  walletRef: string;
  pool: string;
  before: any;
  wsolSide: "x" | "y";
  attempts?: number;
}): Promise<{ after: any; acquired: bigint; attempts: number }> {
  const attempts = Math.max(1, args.attempts ?? 12);
  let after = args.before;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    after = await args.slrd.meteora.getWalletPoolBalances({
      wallet: args.walletRef,
      pool: args.pool,
      commitment:
        attempt >= Math.ceil(attempts * 0.75) ? "finalized" : "confirmed",
    });
    const acquired =
      args.wsolSide === "y"
        ? positiveDelta(after.tokenXRaw, args.before.tokenXRaw)
        : positiveDelta(after.tokenYRaw, args.before.tokenYRaw);
    if (acquired > 0n) return { after, acquired, attempts: attempt };
    if (attempt < attempts) {
      const waitMs = Math.min(1_500, 300 + attempt * 150);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return { after, acquired: 0n, attempts };
}

function positiveOutputDeltaFromTransaction(
  tx: any,
  outputMint: string,
  wallet: string,
): bigint {
  const pre = Array.isArray(tx?.meta?.preTokenBalances)
    ? tx.meta.preTokenBalances
    : [];
  const post = Array.isArray(tx?.meta?.postTokenBalances)
    ? tx.meta.postTokenBalances
    : [];
  const byIndex = new Map<
    number,
    { pre: bigint; post: bigint; owner: string | null }
  >();
  for (const row of pre) {
    if (row?.mint !== outputMint || !Number.isInteger(row?.accountIndex))
      continue;
    byIndex.set(row.accountIndex, {
      pre: raw(row?.uiTokenAmount?.amount),
      post: 0n,
      owner: typeof row?.owner === "string" ? row.owner : null,
    });
  }
  for (const row of post) {
    if (row?.mint !== outputMint || !Number.isInteger(row?.accountIndex))
      continue;
    const current = byIndex.get(row.accountIndex) ?? {
      pre: 0n,
      post: 0n,
      owner: null,
    };
    current.post = raw(row?.uiTokenAmount?.amount);
    if (typeof row?.owner === "string") current.owner = row.owner;
    byIndex.set(row.accountIndex, current);
  }
  let exactOwner = 0n;
  let largestPositive = 0n;
  for (const row of byIndex.values()) {
    const delta = row.post > row.pre ? row.post - row.pre : 0n;
    if (delta <= 0n) continue;
    if (row.owner === wallet) exactOwner += delta;
    if (delta > largestPositive) largestPositive = delta;
  }
  // Parsed token-balance owner is optional on some RPC providers. For a swap
  // transaction the positive output-mint delta is the user receive leg; pool
  // vaults move in the opposite direction. Prefer explicit ownership when present.
  return exactOwner > 0n ? exactOwner : largestPositive;
}

async function confirmedSwapOutputDelta(args: {
  slrd: Solard;
  signatures: string[];
  outputMint: string;
  wallet: string;
}): Promise<bigint> {
  let best = 0n;
  for (const signature of [...args.signatures].reverse()) {
    const tx = await args.slrd.connection().getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const delta = positiveOutputDeltaFromTransaction(
      tx,
      args.outputMint,
      args.wallet,
    );
    if (delta > best) best = delta;
  }
  return best;
}

function raw(value: unknown): bigint {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function short(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length <= 16 ? value : `${value.slice(0, 7)}…${value.slice(-6)}`;
}

function inventoryFromPosition(position: MeteoraPositionSnapshot): Inventory {
  const x = raw(position.totalXRaw) + raw(position.feeXRaw);
  const y = raw(position.totalYRaw) + raw(position.feeYRaw);
  if (x > 0n && y > 0n) return "mixed";
  if (x > 0n) return "x-only";
  if (y > 0n) return "y-only";
  return "empty";
}

function fundedCoverageSummary(position: MeteoraPositionSnapshot): {
  fullRangeFunded: boolean | null;
  expected: number | null;
  funded: number;
  missing: number[];
  unreadable: number;
} {
  const coverage = position.liquidityCoverage;
  return {
    fullRangeFunded: coverage?.fullRangeFunded ?? null,
    expected: coverage?.expectedBinCount ?? null,
    funded: coverage?.fundedBinIds?.length ?? 0,
    missing: coverage?.missingFundedBinIds ?? [],
    unreadable: coverage?.unreadableBinCount ?? 0,
  };
}

function assertSpotCoverageObservable(
  flags: Flags,
  position: MeteoraPositionSnapshot,
  strategy: MeteoraStrategy,
): void {
  if (strategy !== "spot") return;
  const coverage = fundedCoverageSummary(position);
  if (
    coverage.fullRangeFunded == null &&
    !flags.has("allow-unverified-bin-coverage")
  ) {
    throw new Error(
      `Cannot prove funded-bin coverage for Spot position ${position.position}. ` +
        `SDK snapshot exposes funded=${coverage.funded}/${coverage.expected ?? "?"} ` +
        `with ${coverage.unreadable} unreadable bin row(s). Refusing autonomous ` +
        `management because lower/upper bounds alone do not prove the candle is funded. ` +
        `Upgrade the Meteora SDK/parser or explicitly pass --allow-unverified-bin-coverage.`,
    );
  }
}

/**
 * The strategy range is the previous fully closed 5m candle. Do not silently
 * move it to the fundable side of the active bin and do not impose a hidden
 * 35-bin minimum. Optional widening is explicit via --padding-bins or --min-bins.
 */
function targetRange(
  target: Target,
  flags: Flags,
): { minBinId: number; maxBinId: number } {
  let minBinId = target.candleMinBinId;
  let maxBinId = target.candleMaxBinId;
  const explicitMinimum = optionalInteger(flags, "min-bins");
  if (explicitMinimum != null) {
    if (explicitMinimum <= 0) throw new Error("--min-bins must be > 0");
    const width = maxBinId - minBinId + 1;
    if (width < explicitMinimum) {
      const missing = explicitMinimum - width;
      const below = Math.floor(missing / 2);
      minBinId -= below;
      maxBinId += missing - below;
    }
  }
  return { minBinId, maxBinId };
}

function infrastructure(flags: Flags): Record<string, unknown> | undefined {
  const max = flag(flags, "max-infra-lamports");
  if (
    !flags.has("allow-bin-array-init") &&
    !flags.has("allow-bitmap-extension-init") &&
    !max
  ) {
    return undefined;
  }
  return {
    allowBinArrayInit: flags.has("allow-bin-array-init"),
    allowBitmapExtensionInit: flags.has("allow-bitmap-extension-init"),
    ...(max ? { maxNonRefundableLamports: max } : {}),
  };
}

function assertInfrastructureAuthorized(quote: any, flags: Flags): void {
  if (!quote?.requiresNonRefundableInfrastructure) return;
  const requiredBinArrays = Boolean(quote.requiresBinArrayInit);
  const requiredBitmap = Boolean(quote.requiresBitmapExtensionInit);
  if (requiredBinArrays && !flags.has("allow-bin-array-init")) {
    throw new Error(
      `Candle range needs ${Array.isArray(quote.missingBinArrays) ? quote.missingBinArrays.length : "missing"} bin-array initialization(s). ` +
        "Refusing before any position is closed; add --allow-bin-array-init and --max-infra-lamports only if you intend to fund shared infrastructure.",
    );
  }
  if (requiredBitmap && !flags.has("allow-bitmap-extension-init")) {
    throw new Error(
      "Candle range needs a bitmap-extension initialization. Refusing before any position is closed; " +
        "add --allow-bitmap-extension-init and --max-infra-lamports only if intended.",
    );
  }
  const capRaw = flag(flags, "max-infra-lamports");
  if (!capRaw) {
    throw new Error(
      "Shared Meteora infrastructure is required and explicitly allowed, but --max-infra-lamports is missing.",
    );
  }
  let cap: bigint;
  let required: bigint;
  try {
    cap = BigInt(capRaw);
    required = BigInt(String(quote.nonRefundableInfrastructureLamports ?? "0"));
  } catch {
    throw new Error(
      "--max-infra-lamports and infrastructure quote must be integer lamport values",
    );
  }
  if (required > cap) {
    throw new Error(
      `Candle range requires ${required} non-refundable lamports, above --max-infra-lamports=${cap}.`,
    );
  }
}

function exactTokenPool(row: MeteoraPoolSearchResult, token: string): boolean {
  return row.tokenX?.mint === token || row.tokenY?.mint === token;
}

function otherMint(row: MeteoraPoolSearchResult, token: string): string | null {
  if (row.tokenX?.mint === token) return row.tokenY?.mint ?? null;
  if (row.tokenY?.mint === token) return row.tokenX?.mint ?? null;
  return null;
}

async function measuredValue<T>(
  label: string,
  operation: () => Promise<T>,
  summarize: (value: T) => unknown,
): Promise<T> {
  return await m.measure(
    {
      start: () => label,
      end: summarize,
    },
    operation,
  );
}

async function resolveTokenPool(
  slrd: Solard,
  token: string,
  flags: Flags,
): Promise<ResolvedPool> {
  const quote = flag(flags, "quote");
  const needsWsol = Boolean(flag(flags, "sol"));
  const found = await slrd.meteora.searchPools(token, 100);
  let candidates = found.filter((row) => exactTokenPool(row, token));

  if (quote)
    candidates = candidates.filter((row) => otherMint(row, token) === quote);
  if (needsWsol)
    candidates = candidates.filter((row) => otherMint(row, token) === WSOL);

  if (!candidates.length) {
    const requirement = needsWsol
      ? " with WSOL as the quote side (--sol bootstrap requires a WSOL pool)"
      : quote
        ? ` paired with ${quote}`
        : "";
    throw new Error(
      `No Meteora DLMM pool was found for token ${token}${requirement}. ` +
        `Pass an actual DLMM address with --pool, or inspect: slrd meteora token-pools ${token}`,
    );
  }

  candidates.sort((left, right) => {
    const byTvl = (finite(right.tvl) ?? -1) - (finite(left.tvl) ?? -1);
    if (byTvl !== 0) return byTvl;
    return (finite(right.volume24h) ?? -1) - (finite(left.volume24h) ?? -1);
  });

  const selected = candidates[0]!;
  const state = await slrd.meteora.getPoolState(selected.pool, true);
  return {
    pool: selected.pool,
    source: "token",
    token,
    tokenX: state.tokenX.mint,
    tokenY: state.tokenY.mint,
    tvl: finite(selected.tvl),
    volume24h: finite(selected.volume24h),
    matches: candidates.length,
  };
}

async function resolvePool(slrd: Solard, flags: Flags): Promise<ResolvedPool> {
  const token = flag(flags, "token");
  const poolOrToken = flag(flags, "pool");
  if (!token && !poolOrToken)
    throw new Error("Pass --pool <dlmm-pool> or --token <mint>");
  if (token && poolOrToken)
    throw new Error("Use either --pool or --token, not both");
  if (token) return await resolveTokenPool(slrd, token, flags);

  const ref = poolOrToken!;
  try {
    const state = await slrd.meteora.getPoolState(ref, true);
    return {
      pool: state.pool,
      source: "pool",
      token: null,
      tokenX: state.tokenX.mint,
      tokenY: state.tokenY.mint,
      tvl: null,
      volume24h: null,
      matches: 1,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/invalid account discriminator|account discriminator/i.test(message))
      throw error;
    return await resolveTokenPool(slrd, ref, flags);
  }
}

async function previousClosedFiveMinuteTarget(
  slrd: Solard,
  pool: string,
  flags: Flags,
): Promise<Target> {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const currentBucketStart =
    Math.floor(nowSeconds / FIVE_MINUTES_SECONDS) * FIVE_MINUTES_SECONDS;
  const expectedCandleStart = currentBucketStart - FIVE_MINUTES_SECONDS;
  const startTime = currentBucketStart - FIVE_MINUTES_SECONDS * 4;
  const endTime = currentBucketStart - 1;
  // Literal strategy default: contain the candle low/high, without hidden padding.
  const paddingBins = Math.max(0, integer(flags, "padding-bins", 0));
  const maxBreakoutBins = Math.max(
    0,
    integer(flags, "max-breakout-bins", DEFAULT_MAX_BREAKOUT_BINS),
  );

  const [ohlcv, active] = await Promise.all([
    slrd.meteora.getPoolOhlcv(pool, {
      timeframe: "5m",
      startTime,
      endTime,
    }),
    slrd.meteora.getActiveBin(pool, true),
  ]);

  // Do not silently fall back to an older candle. The strategy is specifically
  // "previous closed 5m candle", so at 10:10:05 we require the 10:05..10:10
  // bucket. Falling back to 10:00 would leave liquidity visibly behind price.
  const candle = ohlcv.candles.find(
    (row) => row.timestamp === expectedCandleStart,
  );
  if (!candle) {
    const returned = ohlcv.candles
      .map((row) => new Date(row.timestamp * 1_000).toISOString())
      .join(", ");
    throw new Error(
      `Meteora OHLCV did not return the exact previous 5m bucket ` +
        `${new Date(expectedCandleStart * 1_000).toISOString()}..` +
        `${new Date(currentBucketStart * 1_000).toISOString()} for pool ${pool}. ` +
        `Returned candle starts: ${returned || "none"}`,
    );
  }

  let [candleMinBinId, candleMaxBinId] = await Promise.all([
    slrd.meteora.getBinIdFromPrice(pool, candle.low, true),
    slrd.meteora.getBinIdFromPrice(pool, candle.high, false),
  ]);
  if (candleMinBinId > candleMaxBinId) {
    [candleMinBinId, candleMaxBinId] = [candleMaxBinId, candleMinBinId];
  }
  candleMinBinId -= paddingBins;
  candleMaxBinId += paddingBins;

  const activeBin = Number(active.binId);
  if (!Number.isInteger(activeBin))
    throw new Error(`Meteora returned an invalid active bin for pool ${pool}`);
  const activePriceYPerX = Number(active.price);
  if (!(activePriceYPerX > 0) || !Number.isFinite(activePriceYPerX)) {
    throw new Error(
      `Meteora returned an invalid normalized active price for pool ${pool}`,
    );
  }
  const breakoutBins =
    activeBin < candleMinBinId
      ? candleMinBinId - activeBin
      : activeBin > candleMaxBinId
        ? activeBin - candleMaxBinId
        : 0;
  // Preserve the measurement even when price has escaped the candle.  The cycle
  // turns this into a normal skip rather than crashing a long-lived agent.
  void maxBreakoutBins;

  return {
    pool,
    candleTimestamp: candle.timestamp,
    candleEndTimestamp: candle.timestamp + FIVE_MINUTES_SECONDS,
    candleLow: candle.low,
    candleHigh: candle.high,
    candleClose: candle.close,
    candleVolume: candle.volume,
    activeBin,
    activePriceYPerX,
    candleMinBinId,
    candleMaxBinId,
    breakoutBins,
  };
}

async function inspectTargetInfrastructure(args: {
  slrd: Solard;
  pool: string;
  range: { minBinId: number; maxBinId: number };
  strategy: MeteoraStrategy;
}) {
  return await args.slrd.meteora.inspectPositionInfrastructure({
    pool: args.pool,
    minBinId: args.range.minBinId,
    maxBinId: args.range.maxBinId,
    strategy: args.strategy,
  });
}

async function bootstrapIfNeeded(args: {
  slrd: Solard;
  flags: Flags;
  walletRef: string;
  pool: string;
  target: Target;
  state: RuntimeState;
}): Promise<CycleResult> {
  const { slrd, flags, walletRef, pool, target, state } = args;
  let amountX = uiPositive(
    flag(flags, "amount-x") ?? flag(flags, "x"),
    "--amount-x",
  );
  let amountY = uiPositive(
    flag(flags, "amount-y") ?? flag(flags, "y"),
    "--amount-y",
  );
  let amountXRaw: string | undefined;
  let amountYRaw: string | undefined;
  const sol = uiPositive(flag(flags, "sol"), "--sol");
  if (sol && (amountX || amountY)) {
    throw new Error(
      "Use --sol or --amount-x/--amount-y for bootstrap, not both",
    );
  }

  const range = targetRange(target, flags);
  const candleIso = new Date(target.candleTimestamp * 1_000).toISOString();

  if (state.bootstrapUsed) {
    return {
      action: "no-position",
      pool,
      position: null,
      targetRange: `${range.minBinId}..${range.maxBinId}`,
      activeBin: target.activeBin,
      candle: candleIso,
      reason:
        "managed position is absent after this process already used/adopted its principal; fresh bootstrap is disabled, so the loop remains alive and keeps reconciling on-chain state",
    };
  }

  const strategy = (flag(flags, "strategy") ?? "spot") as MeteoraStrategy;
  const infra = infrastructure(flags);
  const slippageBps = integer(flags, "slippage-bps", 100);
  const balanceSignatures: string[] = [];
  let previewNeedsBalanceSwap = false;

  if (sol) {
    const poolState = await slrd.meteora.getPoolState(pool, true);
    const wsolSide: "x" | "y" =
      poolState.tokenX.mint === WSOL
        ? "x"
        : poolState.tokenY.mint === WSOL
          ? "y"
          : (() => {
              throw new Error(
                "--sol bootstrap requires a WSOL pool; use --amount-x and/or --amount-y for other pairs",
              );
            })();

    if (flags.has("no-auto-balance")) {
      if (wsolSide === "x") amountX = sol;
      else amountY = sol;
    } else {
      const totalRaw = uiToRaw(sol, 9);
      const plan = await measuredValue(
        "plan two-sided bootstrap inventory",
        () =>
          slrd.meteora.quoteSingleSidedBalancedPosition({
            pool,
            minBinId: range.minBinId,
            maxBinId: range.maxBinId,
            strategy,
            side: wsolSide,
            totalAmountRaw: totalRaw,
          }),
        (value) => ({
          side: value.side,
          totalRaw: value.totalAmountRaw,
          targetXRaw: value.targetXRaw,
          targetYRaw: value.targetYRaw,
          swapInputRaw: value.swapInputRaw,
          active: value.activeBin,
          range: `${value.minBinId}..${value.maxBinId}`,
        }),
      );

      const swapInputRaw = raw(plan.swapInputRaw);
      if (swapInputRaw > 0n) {
        const swapForY = wsolSide === "x"; // X->Y when WSOL is X; Y->X when WSOL is Y.
        const swapQuote = await measuredValue(
          "quote bootstrap inventory swap",
          () =>
            slrd.meteora.quoteSwapExactIn({
              pool,
              swapForY,
              amountInRaw: swapInputRaw.toString(),
              slippageBps,
            }),
          (value) => ({
            input: short(value.inputMint),
            output: short(value.outputMint),
            inRaw: value.inAmountRaw,
            outRaw: value.outAmountRaw,
            minOutRaw: value.minOutAmountRaw,
            feeRaw: value.feeRaw,
            priceImpact: value.priceImpact,
          }),
        );
        const consumedRaw = raw(swapQuote.inAmountRaw);
        if (consumedRaw <= 0n || consumedRaw > raw(totalRaw)) {
          throw new Error("Balanced bootstrap produced an invalid swap input");
        }

        if (!flags.has("live")) {
          // The quoted output does not exist in the wallet yet. Building a DLMM
          // add-liquidity transaction against it makes the SDK's balance-aware
          // compute estimation fail with Token-2022 "insufficient funds". A dry
          // run therefore validates the swap quote + infrastructure only; live
          // execution performs the swap, observes the actual received balance,
          // and builds the position from that real amount.
          previewNeedsBalanceSwap = true;
          if (wsolSide === "y") {
            amountYRaw = (raw(totalRaw) - consumedRaw).toString();
          } else {
            amountXRaw = (raw(totalRaw) - consumedRaw).toString();
          }
        } else {
          const before = await measuredValue(
            "snapshot balances before bootstrap swap",
            () =>
              slrd.meteora.getWalletPoolBalances({ wallet: walletRef, pool }),
            (value) => ({
              xRaw: value.tokenXRaw,
              yRaw: value.tokenYRaw,
              xAccounts: value.tokenXAccountCount,
              yAccounts: value.tokenYAccountCount,
              nativeLamports: value.nativeLamports,
            }),
          );
          const existingOutputRaw =
            wsolSide === "y" ? raw(before.tokenXRaw) : raw(before.tokenYRaw);

          if (existingOutputRaw > 0n) {
            if (!flags.has("resume-bootstrap")) {
              throw new Error(
                `Wallet already holds ${existingOutputRaw} raw units of the bootstrap output token while no LP position exists. ` +
                  `Refusing another --sol balancing swap because a previous bootstrap may already have swapped successfully. ` +
                  `Inspect with: slrd balances --wallet ${walletRef}. If this inventory belongs to the interrupted bootstrap, rerun with --resume-bootstrap.`,
              );
            }

            const targetOutputRaw =
              wsolSide === "y" ? raw(plan.targetXRaw) : raw(plan.targetYRaw);
            const targetWsolRaw =
              wsolSide === "y" ? raw(plan.targetYRaw) : raw(plan.targetXRaw);
            const adoptedOutputRaw =
              targetOutputRaw > 0n && existingOutputRaw > targetOutputRaw
                ? targetOutputRaw
                : existingOutputRaw;
            const adoptedWsolRaw =
              targetOutputRaw > 0n
                ? (targetWsolRaw * adoptedOutputRaw) / targetOutputRaw
                : 0n;

            await measuredValue(
              "adopt interrupted bootstrap inventory",
              async () => ({ adoptedOutputRaw, adoptedWsolRaw }),
              (value) => ({
                outputRaw: value.adoptedOutputRaw.toString(),
                wsolRaw: value.adoptedWsolRaw.toString(),
                existingOutputRaw: existingOutputRaw.toString(),
              }),
            );
            state.bootstrapUsed = true;
            if (wsolSide === "y") {
              amountXRaw = adoptedOutputRaw.toString();
              amountYRaw = adoptedWsolRaw.toString();
            } else {
              amountXRaw = adoptedWsolRaw.toString();
              amountYRaw = adoptedOutputRaw.toString();
            }
          } else {
            // The swap is the first write in a balanced bootstrap. Mark the one-shot
            // principal as used before broadcasting so an ambiguous response cannot
            // trigger another conversion in the same process.
            state.bootstrapUsed = true;
            let swapResult: any = null;
            let swapError: unknown = null;
            try {
              swapResult = await measuredValue(
                "balance bootstrap inventory",
                () =>
                  slrd.meteora.swapExactIn(
                    {
                      wallet: walletRef,
                      pool,
                      swapForY,
                      amountInRaw: consumedRaw.toString(),
                      slippageBps,
                    },
                    {
                      live: true,
                      simulate: !flags.has("skip-simulation"),
                      skipPreflight: flags.has("skip-preflight"),
                      commitment: "confirmed",
                    },
                  ),
                (value) => ({ signatures: value.signatures.map(short) }),
              );
            } catch (error) {
              if (!retryableCycleError(error)) throw error;
              swapError = error;
            }

            const swapSignatures = [
              ...(swapResult?.signatures ?? resultSignatures(swapError)),
            ];
            const verified = await measuredValue(
              "verify bootstrap inventory swap by balance delta",
              () =>
                waitForBootstrapOutputBalance({
                  slrd,
                  walletRef,
                  pool,
                  before,
                  wsolSide,
                  attempts: Math.max(
                    4,
                    integer(flags, "post-swap-balance-attempts", 12),
                  ),
                }),
              (value) => ({
                xRaw: value.after.tokenXRaw,
                yRaw: value.after.tokenYRaw,
                xAccounts: value.after.tokenXAccountCount,
                yAccounts: value.after.tokenYAccountCount,
                nativeLamports: value.after.nativeLamports,
                acquiredRaw: value.acquired.toString(),
                attempts: value.attempts,
              }),
            );

            let acquired = verified.acquired;
            if (acquired <= 0n && swapSignatures.length) {
              const outputMint =
                wsolSide === "y" ? before.tokenX.mint : before.tokenY.mint;
              const walletAddress = slrd
                .resolveWallet(walletRef)
                .address.toBase58();
              const txAcquired = await measuredValue(
                "inspect confirmed bootstrap swap token delta",
                () =>
                  confirmedSwapOutputDelta({
                    slrd,
                    signatures: swapSignatures,
                    outputMint,
                    wallet: walletAddress,
                  }),
                (value) => ({
                  outputMint: short(outputMint),
                  acquiredRaw: value.toString(),
                }),
              );
              if (txAcquired > 0n) {
                throw new Error(
                  `Bootstrap swap succeeded and transaction metadata shows ${txAcquired} raw output tokens received, ` +
                    `but the RPC token-account index still does not expose the wallet balance after ${verified.attempts} checks. ` +
                    `Do NOT repeat the --sol bootstrap. Wait for RPC indexing, verify with 'slrd balances --wallet ${walletRef}', ` +
                    `then rerun this agent with --resume-bootstrap.`,
                );
              }
            }

            if (acquired <= 0n) {
              if (swapError) throw swapError;
              throw new Error(
                `Bootstrap balance swap returned without an observable output-token balance increase after ${verified.attempts} checks. ` +
                  `Do NOT blindly repeat --sol; inspect the swap signature and wallet balances first.`,
              );
            }

            balanceSignatures.push(...swapSignatures);
            if (wsolSide === "y") {
              amountXRaw = acquired.toString();
              amountYRaw = (raw(totalRaw) - consumedRaw).toString();
            } else {
              amountXRaw = (raw(totalRaw) - consumedRaw).toString();
              amountYRaw = acquired.toString();
            }
          }
        }
      } else if (wsolSide === "x") {
        amountXRaw = totalRaw;
      } else {
        amountYRaw = totalRaw;
      }
    }
  }

  if (!amountX && !amountY && !amountXRaw && !amountYRaw) {
    return {
      action: "no-position",
      pool,
      position: null,
      targetRange: `${range.minBinId}..${range.maxBinId}`,
      activeBin: target.activeBin,
      candle: candleIso,
      reason:
        "no on-chain position; pass --sol <amount> for a WSOL pair or --amount-x/--amount-y to bootstrap",
    };
  }

  const quote = await measuredValue(
    "inspect candle-range infrastructure",
    () => inspectTargetInfrastructure({ slrd, pool, range, strategy }),
    (value: any) => ({
      range: `${range.minBinId}..${range.maxBinId}`,
      existing: !value.requiresNonRefundableInfrastructure,
      missingBinArrays: Array.isArray(value.missingBinArrays)
        ? value.missingBinArrays.length
        : null,
      bitmapInit: value.requiresBitmapExtensionInit ?? false,
      nonRefundableLamports: value.nonRefundableInfrastructureLamports ?? "0",
    }),
  );

  assertInfrastructureAuthorized(quote, flags);

  if (!flags.has("live") && previewNeedsBalanceSwap) {
    return {
      action: "would-open",
      pool,
      position: null,
      targetRange: `${range.minBinId}..${range.maxBinId}`,
      activeBin: target.activeBin,
      candle: candleIso,
      signatures: balanceSignatures,
      reason:
        "preview validated the balancing swap quote and target-range infrastructure; final DLMM position build is deferred until live execution observes the actual post-swap token balance",
    };
  }

  const prepared = await measuredValue(
    "build initial candle-range position",
    () =>
      slrd.meteora.buildOpenPosition({
        wallet: walletRef,
        pool,
        strategy,
        ...(amountXRaw ? { amountXRaw } : amountX ? { amountX } : {}),
        ...(amountYRaw ? { amountYRaw } : amountY ? { amountY } : {}),
        minBinId: range.minBinId,
        maxBinId: range.maxBinId,
        slippageBps,
        ...(infra ? { infrastructure: infra } : {}),
      }),
    (value) => ({
      position: short(value.position),
      range: `${range.minBinId}..${range.maxBinId}`,
      active: target.activeBin,
      amountX: amountXRaw ? `${amountXRaw} raw` : (amountX ?? "0"),
      amountY: amountYRaw ? `${amountYRaw} raw` : (amountY ?? "0"),
      balanced: Boolean(sol && !flags.has("no-auto-balance")),
      existingInfrastructure: !(quote as any)
        .requiresNonRefundableInfrastructure,
    }),
  );

  if (!flags.has("live")) {
    return {
      action: "would-open",
      pool,
      position: prepared.position ?? null,
      targetRange: `${range.minBinId}..${range.maxBinId}`,
      activeBin: target.activeBin,
      candle: candleIso,
      signatures: balanceSignatures,
    };
  }

  // When no balance swap was necessary, the open itself is the first write.
  state.bootstrapUsed = true;
  const result = await measuredValue(
    "open initial candle-range position",
    () =>
      slrd.meteora.executePreparedAndVerify(
        prepared,
        {
          live: true,
          simulate: !flags.has("skip-simulation"),
          skipPreflight: flags.has("skip-preflight"),
          commitment: "confirmed",
        },
        { attempts: 12, retryDelayMs: 750, commitment: "confirmed" },
      ),
    (value) => ({
      position: short(value.position ?? prepared.position),
      signatures: value.signatures.map(short),
      verified: value.verification?.ok ?? null,
      range: `${range.minBinId}..${range.maxBinId}`,
    }),
  );
  const position = prepared.position ?? result.position ?? null;
  return {
    action: "open",
    pool,
    position,
    targetRange: `${range.minBinId}..${range.maxBinId}`,
    activeBin: target.activeBin,
    candle: candleIso,
    signatures: [...balanceSignatures, ...result.signatures],
  };
}

async function reconcilePosition(args: {
  slrd: Solard;
  flags: Flags;
  state: RuntimeState;
  pool: string;
  wallet: string;
}): Promise<MeteoraPositionSnapshot | null> {
  const { slrd, flags, state, pool, wallet } = args;
  const positions = await slrd.meteora.getPoolPositions(pool, wallet);
  const explicit = flag(flags, "position");

  // --position is a startup seed, not a permanent address pin. A successful
  // rebalance closes that source and creates a replacement with a new address;
  // once state.managedPosition is set, follow the replacement instead of trying
  // to re-adopt the original command-line address on every candle.
  if (state.managedPosition) {
    const selected =
      positions.find((row) => row.position === state.managedPosition) ?? null;
    if (selected) return selected;
    if (positions.length === 1) {
      state.managedPosition = positions[0]!.position;
      return positions[0]!;
    }
    if (positions.length === 0) return null;
    throw new Error(
      `Managed position ${state.managedPosition} disappeared and ${positions.length} positions now exist in the pool. ` +
        "Pass --position <address> to disambiguate.",
    );
  }

  if (explicit) {
    const selected = positions.find((row) => row.position === explicit) ?? null;
    if (!selected) {
      throw new Error(
        `Startup --position ${explicit} is not currently open for wallet ${wallet} in pool ${pool}`,
      );
    }
    state.managedPosition = explicit;
    state.bootstrapUsed = true;
    return selected;
  }

  if (positions.length === 0) return null;
  if (positions.length === 1) {
    state.managedPosition = positions[0]!.position;
    return positions[0]!;
  }

  throw new Error(
    `Found ${positions.length} positions for this wallet in pool ${pool}. ` +
      `Pass --position <address>. Positions: ${positions.map((row) => row.position).join(", ")}`,
  );
}

function liveWriteWindow(flags: Flags): {
  safe: boolean;
  remainingMs: number;
  minimumMs: number;
} {
  const now = Date.now();
  const currentBucketStart =
    Math.floor(now / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  const nextBoundary = currentBucketStart + FIVE_MINUTES_MS;
  const remainingMs = Math.max(0, nextBoundary - now);
  const minimumMs = Math.max(
    5_000,
    integer(flags, "min-write-window-ms", 30_000),
  );
  return { safe: remainingMs >= minimumMs, remainingMs, minimumMs };
}

async function runCycle(args: {
  slrd: Solard;
  flags: Flags;
  state: RuntimeState;
  walletRef: string;
  wallet: string;
  pool: string;
}): Promise<CycleResult> {
  const { slrd, flags, state, walletRef, wallet, pool } = args;
  const target = await measuredValue(
    "previous closed 5m candle",
    () => previousClosedFiveMinuteTarget(slrd, pool, flags),
    (value) => ({
      candleStart: new Date(value.candleTimestamp * 1_000).toISOString(),
      candleEnd: new Date(value.candleEndTimestamp * 1_000).toISOString(),
      low: value.candleLow,
      high: value.candleHigh,
      close: value.candleClose,
      range: `${value.candleMinBinId}..${value.candleMaxBinId}`,
      active: value.activeBin,
      activePriceYPerX: value.activePriceYPerX,
      breakoutBins: value.breakoutBins,
    }),
  );
  const range = targetRange(target, flags);
  const candleIso = new Date(target.candleTimestamp * 1_000).toISOString();
  const strategy = (flag(flags, "strategy") ?? "spot") as MeteoraStrategy;

  const position = await measuredValue(
    "reconcile on-chain position",
    () => reconcilePosition({ slrd, flags, state, pool, wallet }),
    (value) => ({
      position: short(value?.position),
      range:
        value?.lowerBin != null && value?.upperBin != null
          ? `${value.lowerBin}..${value.upperBin}`
          : null,
      found: value != null,
      funded:
        value?.liquidityCoverage?.expectedBinCount != null
          ? `${value.liquidityCoverage.fundedBinIds.length}/${value.liquidityCoverage.expectedBinCount}`
          : null,
      fullRangeFunded: value?.liquidityCoverage?.fullRangeFunded ?? null,
    }),
  );
  // Once this process adopts an existing LP, the capital lifecycle is already
  // established. A later missing position must never re-arm --sol bootstrap.
  if (position) state.bootstrapUsed = true;

  let coverageNeedsRepair = false;
  if (position) {
    assertSpotCoverageObservable(flags, position, strategy);
    const coverage = await measuredValue(
      "inspect funded-bin coverage",
      async () => fundedCoverageSummary(position),
      (value) => ({
        position: short(position.position),
        expected: value.expected,
        funded: value.funded,
        missing: value.missing,
        unreadable: value.unreadable,
        fullRangeFunded: value.fullRangeFunded,
      }),
    );
    coverageNeedsRepair =
      strategy === "spot" && coverage.fullRangeFunded === false;
  }

  if (
    state.lastCompletedCandleTimestamp === target.candleTimestamp &&
    !flags.has("force") &&
    !coverageNeedsRepair
  ) {
    return {
      action: position ? "keep" : "skip",
      pool,
      position: position?.position ?? null,
      currentRange:
        position?.lowerBin != null && position?.upperBin != null
          ? `${position.lowerBin}..${position.upperBin}`
          : null,
      targetRange: `${range.minBinId}..${range.maxBinId}`,
      activeBin: target.activeBin,
      candle: candleIso,
      reason:
        "this fully closed 5m candle was already processed by this manager",
    };
  }

  const maxBreakoutBins = Math.max(
    0,
    integer(flags, "max-breakout-bins", DEFAULT_MAX_BREAKOUT_BINS),
  );
  if (target.breakoutBins > maxBreakoutBins) {
    if (coverageNeedsRepair && position) {
      throw new Error(
        `Spot position ${position.position} does not fund its full declared range, but the new previous-candle target is ` +
          `${target.breakoutBins} bins away from active price (max ${maxBreakoutBins}). Refusing to leave a known-partial LP ` +
          `or chase a stale target automatically; inspect the position/range before resuming.`,
      );
    }
    return {
      action: "skip",
      pool,
      position: position?.position ?? null,
      currentRange:
        position?.lowerBin != null && position?.upperBin != null
          ? `${position.lowerBin}..${position.upperBin}`
          : null,
      targetRange: `${range.minBinId}..${range.maxBinId}`,
      activeBin: target.activeBin,
      candle: candleIso,
      reason: `active bin is ${target.breakoutBins} bin(s) outside the previous candle; stale range not chased`,
    };
  }

  if (!position) {
    if (flags.has("live")) {
      const window = liveWriteWindow(flags);
      if (!window.safe) {
        return {
          action: "skip",
          pool,
          position: null,
          targetRange: `${range.minBinId}..${range.maxBinId}`,
          activeBin: target.activeBin,
          candle: candleIso,
          reason: `only ${window.remainingMs}ms remain in the current 5m bucket; refusing to start a live bootstrap with less than ${window.minimumMs}ms so the candle target cannot expire while transactions are being prepared/confirmed`,
        };
      }
    }
    const opened = await bootstrapIfNeeded({
      slrd,
      flags,
      walletRef,
      pool,
      target,
      state,
    });
    if (flags.has("live") && opened.position)
      state.managedPosition = opened.position;
    return opened;
  }

  const currentMin = Number(position.lowerBin);
  const currentMax = Number(position.upperBin);
  if (!Number.isInteger(currentMin) || !Number.isInteger(currentMax)) {
    throw new Error(`Position ${position.position} has no usable bin range`);
  }

  const inv = inventoryFromPosition(position);
  if (inv === "empty") {
    return {
      action: "skip",
      pool,
      position: position.position,
      currentRange: `${currentMin}..${currentMax}`,
      targetRange: `${range.minBinId}..${range.maxBinId}`,
      activeBin: target.activeBin,
      candle: candleIso,
      inventory: inv,
      reason: "position has no attributable X/Y inventory",
    };
  }

  const shift = Math.max(
    Math.abs(range.minBinId - currentMin),
    Math.abs(range.maxBinId - currentMax),
  );
  const minShift = Math.max(0, integer(flags, "min-shift-bins", 1));
  const shouldMove =
    flags.has("force") || coverageNeedsRepair || shift >= minShift;
  if (!shouldMove) {
    return {
      action: "keep",
      pool,
      position: position.position,
      currentRange: `${currentMin}..${currentMax}`,
      targetRange: `${range.minBinId}..${range.maxBinId}`,
      activeBin: target.activeBin,
      candle: candleIso,
      shiftBins: shift,
      inventory: inv,
      reason: `target shift ${shift} < min-shift-bins ${minShift}`,
    };
  }

  if (flags.has("live")) {
    const window = liveWriteWindow(flags);
    if (!window.safe) {
      return {
        action: "skip",
        pool,
        position: position.position,
        currentRange: `${currentMin}..${currentMax}`,
        targetRange: `${range.minBinId}..${range.maxBinId}`,
        activeBin: target.activeBin,
        candle: candleIso,
        shiftBins: shift,
        inventory: inv,
        reason: `only ${window.remainingMs}ms remain in the current 5m bucket; refusing to close a live position with less than ${window.minimumMs}ms before the candle target expires`,
      };
    }
  }

  const infra = infrastructure(flags);
  const replacementInfrastructure = await measuredValue(
    "preflight replacement candle range",
    () => inspectTargetInfrastructure({ slrd, pool, range, strategy }),
    (value: any) => ({
      range: `${range.minBinId}..${range.maxBinId}`,
      existing: !value.requiresNonRefundableInfrastructure,
      missingBinArrays: Array.isArray(value.missingBinArrays)
        ? value.missingBinArrays.length
        : null,
      nonRefundableLamports: value.nonRefundableInfrastructureLamports ?? "0",
    }),
  );
  // movePositionFromSource closes first, then builds the replacement. Enforce
  // the shared-infrastructure policy here so a predictable preflight refusal
  // can never strand principal in the wallet after closing the source.
  assertInfrastructureAuthorized(replacementInfrastructure, flags);

  if (!flags.has("live")) {
    return {
      action: "would-move",
      pool,
      position: position.position,
      currentRange: `${currentMin}..${currentMax}`,
      targetRange: `${range.minBinId}..${range.maxBinId}`,
      activeBin: target.activeBin,
      candle: candleIso,
      shiftBins: shift,
      inventory: inv,
      reason: coverageNeedsRepair
        ? "current Spot position does not fund every bin in its declared range; rebuild required"
        : undefined,
    };
  }

  // Do not simulate a replacement open while the source principal is still
  // locked in the existing position. A wallet-balance simulation at this point
  // produces a false "insufficient lamports" failure for exactly the capital we
  // intend to recover by closing. Infrastructure/geometry are preflighted above;
  // the real replacement is built only after source proceeds are observable.

  const result = await measuredValue(
    `move source position ${short(position.position)}`,
    () =>
      slrd.meteora.movePositionFromSource(
        {
          wallet: walletRef,
          pool,
          position: position.position,
          strategy,
          minBinId: range.minBinId,
          maxBinId: range.maxBinId,
          slippageBps: integer(flags, "slippage-bps", 100),
          balanceInventory: !flags.has("no-auto-balance"),
          ...(infra ? { infrastructure: infra } : {}),
        },
        {
          live: true,
          simulate: !flags.has("skip-simulation"),
          skipPreflight: flags.has("skip-preflight"),
          commitment: "confirmed",
        },
        { attempts: 6, retryDelayMs: 500, commitment: "confirmed" },
      ),
    (value) => ({
      source: short(value.sourcePosition),
      target: short(value.targetPosition),
      close: value.close.signatures.map(short),
      open: value.open.signatures.map(short),
      range: `${range.minBinId}..${range.maxBinId}`,
      attribution: {
        x: value.attribution.reopenedXRaw,
        y: value.attribution.reopenedYRaw,
        nativeRecovery: value.attribution.nativeRecoveryAppliedTo
          ? {
              side: value.attribution.nativeRecoveryAppliedTo,
              lamports: value.attribution.observedRecoveredNativeLamports,
            }
          : null,
        swap: value.attribution.marketSwapPerformed
          ? {
              direction: value.attribution.marketSwapDirection,
              inRaw: value.attribution.marketSwapInputRaw,
              outRaw: value.attribution.marketSwapOutputRaw,
              signatures: value.attribution.marketSwapSignatures.map(short),
            }
          : null,
      },
    }),
  );
  state.managedPosition = result.targetPosition;
  return {
    action: "move",
    pool,
    position: result.sourcePosition,
    targetPosition: result.targetPosition,
    currentRange: `${currentMin}..${currentMax}`,
    targetRange: `${range.minBinId}..${range.maxBinId}`,
    activeBin: target.activeBin,
    candle: candleIso,
    shiftBins: shift,
    inventory: inv,
    signatures: [
      ...result.close.signatures,
      ...result.attribution.marketSwapSignatures,
      ...result.open.signatures,
    ],
  };
}

function continuousManager(flags: Flags): boolean {
  // A live liquidity *agent* should keep managing its position unless the caller
  // explicitly asks for one cycle. --loop is retained for backwards compatibility
  // and for deliberately looping previews.
  return flags.has("loop") || (flags.has("live") && !flags.has("once"));
}

function settleMs(flags: Flags): number {
  return Math.max(0, Math.min(60_000, integer(flags, "settle-ms", 5_000)));
}

function nextRunAtAfterCycle(result: CycleResult, flags: Flags): number {
  // Schedule from the candle we just processed, not from the wall clock after
  // the cycle. If a cycle starts just before a boundary and finishes just after
  // it, wall-clock scheduling would otherwise jump an entire extra 5m candle.
  const candleStartMs = Date.parse(result.candle);
  if (Number.isFinite(candleStartMs)) {
    const nextCandleAvailableAt =
      candleStartMs + FIVE_MINUTES_MS * 2 + settleMs(flags);
    if (nextCandleAvailableAt > Date.now() + 250) return nextCandleAvailableAt;
    // We crossed the expected wake time while processing. Run again promptly;
    // the lastCompletedCandle guard prevents duplicate writes to the same candle.
    return Date.now() + 500;
  }
  return (
    (Math.floor(Date.now() / FIVE_MINUTES_MS) + 1) * FIVE_MINUTES_MS +
    settleMs(flags)
  );
}

function parseRange(
  text: string | null | undefined,
): { minBinId: number; maxBinId: number } | null {
  const match = /^(\-?\d+)\.\.(\-?\d+)$/.exec(text ?? "");
  if (!match) return null;
  const minBinId = Number(match[1]);
  const maxBinId = Number(match[2]);
  return Number.isInteger(minBinId) &&
    Number.isInteger(maxBinId) &&
    minBinId <= maxBinId
    ? { minBinId, maxBinId }
    : null;
}

async function verifyManagedPositionAfterCycle(args: {
  slrd: Solard;
  flags: Flags;
  state: RuntimeState;
  walletRef: string;
  pool: string;
  result: CycleResult;
}): Promise<void> {
  if (!args.flags.has("live")) return;
  const position =
    args.result.targetPosition ??
    args.state.managedPosition ??
    args.result.position;
  if (!position) return;

  const expectedRange =
    args.result.action === "open" || args.result.action === "move"
      ? parseRange(args.result.targetRange)
      : parseRange(args.result.currentRange);

  const verification = await measuredValue(
    "verify managed position after cycle",
    () =>
      expectedRange
        ? args.slrd.meteora.verifyPositionRange({
            pool: args.pool,
            position,
            wallet: args.walletRef,
            minBinId: expectedRange.minBinId,
            maxBinId: expectedRange.maxBinId,
            attempts: 4,
            retryDelayMs: 500,
            commitment: "confirmed",
          })
        : args.slrd.meteora.verifyPositionPresent({
            pool: args.pool,
            position,
            wallet: args.walletRef,
            attempts: 4,
            retryDelayMs: 500,
            commitment: "confirmed",
          }),
    (value) => ({
      position: short(position),
      ok: value.ok,
      expectedRange: expectedRange
        ? `${expectedRange.minBinId}..${expectedRange.maxBinId}`
        : null,
      actualRange:
        value.actual?.lowerBin != null && value.actual?.upperBin != null
          ? `${value.actual.lowerBin}..${value.actual.upperBin}`
          : null,
      errors: value.errors,
      funded:
        value.actual?.liquidityCoverage?.expectedBinCount != null
          ? `${value.actual.liquidityCoverage.fundedBinIds.length}/${value.actual.liquidityCoverage.expectedBinCount}`
          : null,
      fullRangeFunded: value.actual?.liquidityCoverage?.fullRangeFunded ?? null,
      missingFundedBins:
        value.actual?.liquidityCoverage?.missingFundedBinIds ?? [],
    }),
  );

  if (!verification.ok) {
    throw new Error(
      `Managed Meteora position ${position} failed post-cycle verification: ${verification.errors.join("; ") || "unknown verification failure"}`,
    );
  }

  const strategy = (flag(args.flags, "strategy") ?? "spot") as MeteoraStrategy;
  if (strategy === "spot" && verification.actual) {
    const coverage = fundedCoverageSummary(verification.actual);
    if (coverage.fullRangeFunded === false) {
      throw new Error(
        `Managed Spot position ${position} has correct declared bounds but does not fund the complete range: ` +
          `${coverage.funded}/${coverage.expected ?? "?"} funded; missing bins ` +
          `${coverage.missing.join(",") || "unknown"}. Stopping instead of repeatedly churning principal.`,
      );
    }
    if (
      coverage.fullRangeFunded == null &&
      !args.flags.has("allow-unverified-bin-coverage")
    ) {
      throw new Error(
        `Managed Spot position ${position} range verified, but per-bin funded coverage cannot be proven. ` +
          `Stopping because lower/upper bounds alone are insufficient; pass --allow-unverified-bin-coverage only if intentional.`,
      );
    }
  }
  args.state.managedPosition = position;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.has("once") && flags.has("loop")) {
    throw new Error("Use --once or --loop, not both");
  }
  const continuous = continuousManager(flags);
  if (flags.has("help")) {
    process.stdout.write(
      "Meteora previous-closed-5m-candle liquidity agent example\n\n" +
        "Usage:\n" +
        "  slrd run examples/meteora-liquidity-agent.ts --pool <dlmm-pool> --wallet <wallet> [--position <position>] [--live] [--once|--loop]\n" +
        "  slrd run examples/meteora-liquidity-agent.ts --token <mint> --wallet <wallet> --sol 0.1 --live\n\n" +
        "Default target is the exact bin interval containing the previous fully closed 5m candle low/high.\n" +
        "With --sol, the agent balances that principal into both pool tokens before a Spot deposit so both sides of an in-range candle can be funded; --no-auto-balance disables this.\n" +
        "There is no hidden minimum width. --padding-bins N and --min-bins N are explicit opt-in widening controls.\n" +
        `Small breakouts are tolerated by default (--max-breakout-bins ${DEFAULT_MAX_BREAKOUT_BINS}); set 0 for strict previous-candle containment.\n` +
        "Live writes require at least 30s remaining before the next 5m boundary by default, preventing a previous-candle target from becoming stale during build/confirmation; tune with --min-write-window-ms.\n" +
        "The example keeps only process memory and reconciles zero/one/many on-chain positions as bootstrap/adopt/require --position.\n" +
        "Before opening or moving it inspects shared bin infrastructure; missing arrays remain denied unless explicitly authorized.\n" +
        "If a live bootstrap swap succeeded but opening was interrupted, --resume-bootstrap adopts existing output inventory instead of swapping principal again.\n" +
        "Live mode manages continuously by default; pass --once for exactly one cycle. --loop remains available for looping previews/backward compatibility.\n" +
        "For Spot positions the manager also proves every declared bin carries non-zero position liquidity; known partial coverage forces a source-only rebuild. Unverifiable SDK coverage stops the agent unless --allow-unverified-bin-coverage is explicitly supplied.\n" +
        "--position is only a startup disambiguation seed; after a rebalance the verified replacement address becomes the managed position automatically.\n" +
        "Completed candles are deduplicated, scheduling is derived from the candle just processed, and retryable RPC failures retry with bounded backoff instead of skipping directly to the next candle.\n" +
        "Runtime progress is emitted through measure-fn. Live writes also require SOLARD_ENABLE_LIVE_TRADES=1.\n",
    );
    return;
  }

  // Strategy scripts are long-lived applications, not ordinary quiet SDK calls.
  // Use measure-fn as the runtime console so each RPC/strategy phase is visible.
  configure({ silent: false });
  m.measureSync(
    {
      start: () => `agent policy v${AGENT_POLICY_VERSION}`,
      end: (value) => value,
    },
    () => ({
      exactPreviousClosed5m: true,
      maxBreakoutBins: Math.max(
        0,
        integer(flags, "max-breakout-bins", DEFAULT_MAX_BREAKOUT_BINS),
      ),
      autoBalance: !flags.has("no-auto-balance"),
      minWriteWindowMs: Math.max(
        5_000,
        integer(flags, "min-write-window-ms", 30_000),
      ),
      precloseWalletFundingSimulation: false,
      sourceOnlyRebalance: true,
      postSwapBalanceAttempts: Math.max(
        4,
        integer(flags, "post-swap-balance-attempts", 12),
      ),
      resumeBootstrap: flags.has("resume-bootstrap"),
      continuousManager: continuous,
      oneShot: !continuous,
      dedupeCompletedCandles: true,
      postCyclePositionVerification: true,
      spotFundedBinCoverageProof: true,
      allowUnverifiedBinCoverage: flags.has("allow-unverified-bin-coverage"),
    }),
  );

  const walletRef = required(flags, "wallet");
  const slrd = createTraderSolard();
  const wallet = slrd.resolveWallet(walletRef).address.toBase58();
  const state: RuntimeState = {
    managedPosition: null,
    bootstrapUsed: false,
    lastCompletedCandleTimestamp: null,
  };

  try {
    const resolved = await measuredValue(
      "resolve Meteora LP target",
      () => resolvePool(slrd, flags),
      (value) => ({
        wallet: short(wallet),
        pool: value.pool,
        source: value.source,
        token: short(value.token),
        pair: `${short(value.tokenX)}/${short(value.tokenY)}`,
        matches: value.matches,
        tvl: value.tvl,
      }),
    );

    let consecutiveFailures = 0;
    while (true) {
      let cycleResult: CycleResult;
      try {
        cycleResult = await m.measure(
          {
            start: () => "5m liquidity cycle",
            end: (result: CycleResult) => result,
          },
          async () =>
            await runCycle({
              slrd,
              flags,
              state,
              walletRef,
              wallet,
              pool: resolved.pool,
            }),
        );

        await verifyManagedPositionAfterCycle({
          slrd,
          flags,
          state,
          walletRef,
          pool: resolved.pool,
          result: cycleResult,
        });
        const completedAt = Date.parse(cycleResult.candle);
        if (Number.isFinite(completedAt)) {
          state.lastCompletedCandleTimestamp = Math.trunc(completedAt / 1_000);
        }
        consecutiveFailures = 0;
      } catch (error) {
        if (
          !continuous ||
          flags.has("fail-fast") ||
          !retryableCycleError(error)
        ) {
          throw error;
        }
        consecutiveFailures += 1;
        const baseRetryMs = Math.max(500, integer(flags, "retry-ms", 2_000));
        const retryMs = Math.min(
          30_000,
          baseRetryMs * 2 ** Math.min(4, consecutiveFailures - 1),
        );
        await m.measure(
          {
            start: () => "recoverable cycle failure",
            end: (value: {
              retryInMs: number;
              failures: number;
              error: string;
            }) => value,
          },
          async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
            return {
              retryInMs: retryMs,
              failures: consecutiveFailures,
              error: error instanceof Error ? error.message : String(error),
            };
          },
        );
        continue;
      }

      if (!continuous) return;
      const next = nextRunAtAfterCycle(cycleResult, flags);
      await m.measure(
        {
          start: () => "wait for next closed 5m candle",
          end: (result: { next: string; fromCandle: string }) => result,
        },
        async () => {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, Math.max(250, next - Date.now())),
          );
          return {
            next: new Date(next).toISOString(),
            fromCandle: cycleResult.candle,
          };
        },
      );
    }
  } finally {
    slrd.close();
  }
}

await main();
