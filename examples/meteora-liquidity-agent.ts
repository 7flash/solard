#!/usr/bin/env bun
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

type Flags = Map<string, string>;
type Inventory = "x-only" | "y-only" | "mixed" | "empty";

type Target = {
  pool: string;
  candleTimestamp: number;
  candleLow: number;
  candleHigh: number;
  candleClose: number;
  candleVolume: number;
  activeBin: number;
  candleMinBinId: number;
  candleMaxBinId: number;
  breakoutBins: number;
};

type RuntimeState = {
  managedPosition: string | null;
  bootstrapUsed: boolean;
};

type ResolvedPool = {
  pool: string;
  source: "pool" | "token";
  token: string | null;
  tokenX: string | null;
  tokenY: string | null;
  tvl: number | null;
  volume24h: number | null;
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

function inventoryFromPosition(position: MeteoraPositionSnapshot): Inventory {
  const x = raw(position.totalXRaw) + raw(position.feeXRaw);
  const y = raw(position.totalYRaw) + raw(position.feeYRaw);
  if (x > 0n && y > 0n) return "mixed";
  if (x > 0n) return "x-only";
  if (y > 0n) return "y-only";
  return "empty";
}

function fundableRange(args: {
  minBinId: number;
  maxBinId: number;
  activeBin: number;
  minTotalBins: number;
  inventory: Inventory;
}): { minBinId: number; maxBinId: number } | null {
  let minBinId = Math.min(args.minBinId, args.activeBin);
  let maxBinId = Math.max(args.maxBinId, args.activeBin);
  const desiredWidth = Math.max(args.minTotalBins, maxBinId - minBinId + 1);

  // A one-sided source cannot fund both sides of active without a swap. Preserve
  // the candle-derived width, but place the position entirely on its fundable side.
  if (args.inventory === "x-only") {
    return {
      minBinId: args.activeBin,
      maxBinId: args.activeBin + desiredWidth - 1,
    };
  }
  if (args.inventory === "y-only") {
    return {
      minBinId: args.activeBin - desiredWidth + 1,
      maxBinId: args.activeBin,
    };
  }
  if (args.inventory === "empty") return null;

  const missing = Math.max(0, desiredWidth - (maxBinId - minBinId + 1));
  const below = Math.floor(missing / 2);
  minBinId -= below;
  maxBinId += missing - below;
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

function exactTokenPool(row: MeteoraPoolSearchResult, token: string): boolean {
  return row.tokenX?.mint === token || row.tokenY?.mint === token;
}

function otherMint(row: MeteoraPoolSearchResult, token: string): string | null {
  if (row.tokenX?.mint === token) return row.tokenY?.mint ?? null;
  if (row.tokenY?.mint === token) return row.tokenX?.mint ?? null;
  return null;
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

  if (quote) {
    candidates = candidates.filter((row) => otherMint(row, token) === quote);
  }
  if (needsWsol) {
    candidates = candidates.filter((row) => otherMint(row, token) === WSOL);
  }

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
  // Verify the indexed result is actually decodable as a current DLMM account
  // before the strategy reaches candle/bin calculations.
  const state = await slrd.meteora.getPoolState(selected.pool, true);
  process.stdout.write(
    `RESOLVE  token=${token}  pool=${selected.pool}  ` +
      `pair=${state.tokenX.mint}/${state.tokenY.mint}  ` +
      `matches=${candidates.length}  selected=highest-tvl\n`,
  );
  return {
    pool: selected.pool,
    source: "token",
    token,
    tokenX: state.tokenX.mint,
    tokenY: state.tokenY.mint,
    tvl: finite(selected.tvl),
    volume24h: finite(selected.volume24h),
  };
}

async function resolvePool(slrd: Solard, flags: Flags): Promise<ResolvedPool> {
  const token = flag(flags, "token");
  const poolOrToken = flag(flags, "pool");
  if (!token && !poolOrToken) {
    throw new Error("Pass --pool <dlmm-pool> or --token <mint>");
  }
  if (token && poolOrToken) {
    throw new Error("Use either --pool or --token, not both");
  }
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
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/invalid account discriminator|account discriminator/i.test(message)) {
      throw error;
    }
    process.stdout.write(
      `POOL REF  ${ref} is not a DLMM pool account; trying it as a token mint.\n`,
    );
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
  const startTime = currentBucketStart - FIVE_MINUTES_SECONDS * 4;
  const endTime = currentBucketStart - 1;
  const paddingBins = Math.max(0, integer(flags, "padding-bins", 1));
  const maxBreakoutBins = Math.max(0, integer(flags, "max-breakout-bins", 50));

  const [ohlcv, active] = await Promise.all([
    slrd.meteora.getPoolOhlcv(pool, {
      timeframe: "5m",
      startTime,
      endTime,
    }),
    slrd.meteora.getActiveBin(pool, true),
  ]);

  const candle = [...ohlcv.candles]
    .filter((row) => row.timestamp < currentBucketStart)
    .sort((a, b) => a.timestamp - b.timestamp)
    .at(-1);
  if (!candle) {
    throw new Error(`No fully closed 5m candle is available for pool ${pool}`);
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
  if (!Number.isInteger(activeBin)) {
    throw new Error(`Meteora returned an invalid active bin for pool ${pool}`);
  }
  const breakoutBins =
    activeBin < candleMinBinId
      ? candleMinBinId - activeBin
      : activeBin > candleMaxBinId
        ? activeBin - candleMaxBinId
        : 0;
  if (breakoutBins > maxBreakoutBins) {
    throw new Error(
      `Active bin is ${breakoutBins} bins outside the previous candle; ` +
        `max-breakout-bins=${maxBreakoutBins}`,
    );
  }

  process.stdout.write(
    `CANDLE  ${new Date(candle.timestamp * 1_000).toISOString()}  ` +
      `low=${candle.low} high=${candle.high} close=${candle.close}  ` +
      `bins=${candleMinBinId}..${candleMaxBinId} active=${activeBin}\n`,
  );

  return {
    pool,
    candleTimestamp: candle.timestamp,
    candleLow: candle.low,
    candleHigh: candle.high,
    candleClose: candle.close,
    candleVolume: candle.volume,
    activeBin,
    candleMinBinId,
    candleMaxBinId,
    breakoutBins,
  };
}

async function bootstrapIfNeeded(args: {
  slrd: Solard;
  flags: Flags;
  walletRef: string;
  pool: string;
  target: Target;
  state: RuntimeState;
}): Promise<string | null> {
  const { slrd, flags, walletRef, pool, target, state } = args;
  let amountX = uiPositive(
    flag(flags, "amount-x") ?? flag(flags, "x"),
    "--amount-x",
  );
  let amountY = uiPositive(
    flag(flags, "amount-y") ?? flag(flags, "y"),
    "--amount-y",
  );
  const sol = uiPositive(flag(flags, "sol"), "--sol");
  if (sol && (amountX || amountY)) {
    throw new Error(
      "Use --sol or --amount-x/--amount-y for bootstrap, not both",
    );
  }

  if (state.bootstrapUsed) {
    throw new Error(
      "This process already used its bootstrap allocation and the managed position is gone. Refusing to inject fresh principal again.",
    );
  }

  if (sol) {
    const poolState = await slrd.meteora.getPoolState(pool, true);
    if (poolState.tokenX.mint === WSOL) amountX = sol;
    else if (poolState.tokenY.mint === WSOL) amountY = sol;
    else {
      throw new Error(
        "--sol bootstrap requires a WSOL pool; use --amount-x and/or --amount-y for other pairs",
      );
    }
  }

  if (!amountX && !amountY) {
    process.stdout.write(
      "NO POSITION  No on-chain position exists for this wallet/pool. " +
        "Pass --sol <amount> for a WSOL pair, or --amount-x/--amount-y, to bootstrap.\n",
    );
    return null;
  }

  const bootstrapInventory: Inventory =
    amountX && amountY ? "mixed" : amountX ? "x-only" : "y-only";
  const range = fundableRange({
    minBinId: target.candleMinBinId,
    maxBinId: target.candleMaxBinId,
    activeBin: target.activeBin,
    minTotalBins: Math.max(2, integer(flags, "min-bins", 35)),
    inventory: bootstrapInventory,
  });
  if (!range) throw new Error("Bootstrap inventory is empty");

  // Default policy deliberately means "existing bin infrastructure only". If
  // required bin arrays/bitmap extension do not exist, buildOpenPosition fails
  // closed unless the caller explicitly opts in with the infrastructure flags.
  const infra = infrastructure(flags);
  const prepared = await slrd.meteora.buildOpenPosition({
    wallet: walletRef,
    pool,
    strategy: (flag(flags, "strategy") ?? "spot") as MeteoraStrategy,
    amountX,
    amountY,
    minBinId: range.minBinId,
    maxBinId: range.maxBinId,
    slippageBps: integer(flags, "slippage-bps", 100),
    ...(infra ? { infrastructure: infra } : {}),
  });

  const infraQuote = prepared.infrastructurePreflight?.quote;
  process.stdout.write(
    `${flags.has("live") ? "OPEN" : "WOULD OPEN"}  ` +
      `${prepared.position ?? "new-position"}  range=${range.minBinId}..${range.maxBinId}  ` +
      `active=${target.activeBin}  existingInfra=${
        infraQuote ? !infraQuote.requiresNonRefundableInfrastructure : "unknown"
      }\n`,
  );

  if (!flags.has("live")) return prepared.position ?? null;
  state.bootstrapUsed = true;
  const result = await slrd.meteora.executePreparedAndVerify(
    prepared,
    {
      live: true,
      simulate: !flags.has("skip-simulation"),
      skipPreflight: flags.has("skip-preflight"),
      commitment: "confirmed",
    },
    { attempts: 6, retryDelayMs: 500, commitment: "confirmed" },
  );
  process.stdout.write(`OPENED  ${(result.signatures ?? []).join(",")}\n`);
  return prepared.position ?? result.position ?? null;
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

  if (explicit) {
    const selected = positions.find((row) => row.position === explicit) ?? null;
    if (!selected) {
      throw new Error(
        `--position ${explicit} is not currently open for wallet ${wallet} in pool ${pool}`,
      );
    }
    if (state.managedPosition !== explicit) {
      process.stdout.write(`RECONCILE  explicit position=${explicit}\n`);
      state.managedPosition = explicit;
    }
    return selected;
  }

  if (state.managedPosition) {
    const selected =
      positions.find((row) => row.position === state.managedPosition) ?? null;
    if (selected) return selected;

    // A source-only move changes the position address. If a fresh chain read
    // contains exactly one position, it is safe enough for this wallet+pool
    // scoped example to reconcile to the replacement in memory.
    if (positions.length === 1) {
      process.stdout.write(
        `RECONCILE  ${state.managedPosition} -> ${positions[0]!.position}\n`,
      );
      state.managedPosition = positions[0]!.position;
      return positions[0]!;
    }
    if (positions.length === 0) return null;
    throw new Error(
      `Managed position ${state.managedPosition} disappeared and ${positions.length} positions now exist in the pool. ` +
        "Pass --position <address> to disambiguate.",
    );
  }

  if (positions.length === 0) return null;
  if (positions.length === 1) {
    state.managedPosition = positions[0]!.position;
    process.stdout.write(
      `RECONCILE  adopted sole on-chain position=${state.managedPosition}\n`,
    );
    return positions[0]!;
  }

  throw new Error(
    `Found ${positions.length} positions for this wallet in pool ${pool}. ` +
      `On-chain state does not encode which one belongs to this process; pass --position <address>. ` +
      `Positions: ${positions.map((row) => row.position).join(", ")}`,
  );
}

async function runCycle(args: {
  slrd: Solard;
  flags: Flags;
  state: RuntimeState;
  walletRef: string;
  wallet: string;
  pool: string;
}): Promise<void> {
  const { slrd, flags, state, walletRef, wallet, pool } = args;
  const target = await previousClosedFiveMinuteTarget(slrd, pool, flags);
  const position = await reconcilePosition({
    slrd,
    flags,
    state,
    pool,
    wallet,
  });

  if (!position) {
    const openedPosition = await bootstrapIfNeeded({
      slrd,
      flags,
      walletRef,
      pool,
      target,
      state,
    });
    if (flags.has("live") && openedPosition)
      state.managedPosition = openedPosition;
    return;
  }

  const currentMin = Number(position.lowerBin);
  const currentMax = Number(position.upperBin);
  if (!Number.isInteger(currentMin) || !Number.isInteger(currentMax)) {
    throw new Error(`Position ${position.position} has no usable bin range`);
  }

  const inv = inventoryFromPosition(position);
  const range = fundableRange({
    minBinId: target.candleMinBinId,
    maxBinId: target.candleMaxBinId,
    activeBin: target.activeBin,
    minTotalBins: Math.max(2, integer(flags, "min-bins", 35)),
    inventory: inv,
  });
  if (!range) {
    process.stdout.write(
      `SKIP  ${position.position} has no attributable X/Y inventory\n`,
    );
    return;
  }

  const shift = Math.max(
    Math.abs(range.minBinId - currentMin),
    Math.abs(range.maxBinId - currentMax),
  );
  const minShift = Math.max(0, integer(flags, "min-shift-bins", 5));
  const action = flags.has("force") || shift >= minShift ? "MOVE" : "KEEP";
  process.stdout.write(
    `${action}  ${position.position}  current=${currentMin}..${currentMax}  ` +
      `target=${range.minBinId}..${range.maxBinId}  active=${target.activeBin}  ` +
      `shift=${shift}  inventory=${inv}\n`,
  );

  if (action !== "MOVE" || !flags.has("live")) return;
  const infra = infrastructure(flags);
  const result = await slrd.meteora.movePositionFromSource(
    {
      wallet: walletRef,
      pool,
      position: position.position,
      strategy: (flag(flags, "strategy") ?? "spot") as MeteoraStrategy,
      minBinId: range.minBinId,
      maxBinId: range.maxBinId,
      slippageBps: integer(flags, "slippage-bps", 100),
      ...(infra ? { infrastructure: infra } : {}),
    },
    {
      live: true,
      simulate: !flags.has("skip-simulation"),
      skipPreflight: flags.has("skip-preflight"),
      commitment: "confirmed",
    },
    { attempts: 6, retryDelayMs: 500, commitment: "confirmed" },
  );
  state.managedPosition = result.targetPosition;
  process.stdout.write(
    `MOVED  ${result.sourcePosition} -> ${result.targetPosition}  ` +
      `close=${result.close.signatures.join(",")}  open=${result.open.signatures.join(",")}\n`,
  );
}

function nextRunAt(flags: Flags): number {
  const settleMs = Math.max(
    0,
    Math.min(60_000, integer(flags, "settle-ms", 5_000)),
  );
  return (
    (Math.floor(Date.now() / FIVE_MINUTES_MS) + 1) * FIVE_MINUTES_MS + settleMs
  );
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.has("help")) {
    process.stdout.write(
      "Meteora previous-closed-5m-candle liquidity agent example\n\n" +
        "Usage:\n" +
        "  slrd run examples/meteora-liquidity-agent.ts --pool <dlmm-pool> --wallet <wallet> [--position <position>] [--loop] [--live]\n" +
        "  slrd run examples/meteora-liquidity-agent.ts --token <mint> --wallet <wallet> --sol 0.1 --loop --live\n\n" +
        "If --pool is accidentally given a token mint, the example falls back to token-pool discovery.\n" +
        "With --sol it prefers an existing WSOL DLMM pool and selects the highest-TVL exact match.\n" +
        "State is in memory only. On restart, zero/one/many positions reconcile as bootstrap/adopt/require --position.\n" +
        "By default the SDK will only open/move when the required shared bin infrastructure already exists.\n" +
        "Missing bin arrays remain denied unless --allow-bin-array-init plus --max-infra-lamports is explicitly supplied.\n" +
        "Live Meteora writes also require SOLARD_ENABLE_LIVE_TRADES=1.\n",
    );
    return;
  }

  const walletRef = required(flags, "wallet");
  const slrd = createTraderSolard();
  const wallet = slrd.resolveWallet(walletRef).address.toBase58();
  const state: RuntimeState = { managedPosition: null, bootstrapUsed: false };

  try {
    const resolved = await resolvePool(slrd, flags);
    process.stdout.write(
      `LP AGENT  wallet=${wallet}  pool=${resolved.pool}  source=${resolved.source}\n`,
    );

    while (true) {
      try {
        await runCycle({
          slrd,
          flags,
          state,
          walletRef,
          wallet,
          pool: resolved.pool,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`LP AGENT ERROR  ${message}\n`);
        if (!flags.has("loop") || !flags.has("continue-on-error")) throw error;
      }
      if (!flags.has("loop")) return;
      const next = nextRunAt(flags);
      process.stdout.write(`NEXT  ${new Date(next).toISOString()}\n`);
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(250, next - Date.now())),
      );
    }
  } finally {
    slrd.close();
  }
}

await main();
