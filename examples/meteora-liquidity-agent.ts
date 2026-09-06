#!/usr/bin/env bun
import {
  createTraderSolard,
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

type AgentState = {
  managedPosition: string | null;
  bootstrapConsumed: boolean;
  everManagedPosition: boolean;
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

  // A one-sided source cannot fund both sides of the active bin without a swap.
  // Preserve the candle-derived width, but place it entirely on the fundable side.
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
}): Promise<string | null> {
  const { slrd, flags, walletRef, pool, target } = args;
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

  if (sol) {
    const state = await slrd.meteora.getPoolState(pool, true);
    if (state.tokenX.mint === WSOL) amountX = sol;
    else if (state.tokenY.mint === WSOL) amountY = sol;
    else {
      throw new Error(
        "--sol bootstrap requires a WSOL pool; use --amount-x and/or --amount-y for other pairs",
      );
    }
  }

  if (!amountX && !amountY) {
    process.stdout.write(
      "NO POSITION  This strategy has nothing to manage yet. " +
        "Pass --sol <amount> for a WSOL pool, or --amount-x/--amount-y, to bootstrap it.\n",
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

  const prepared = await slrd.meteora.buildOpenPosition({
    wallet: walletRef,
    pool,
    strategy: (flag(flags, "strategy") ?? "spot") as MeteoraStrategy,
    amountX,
    amountY,
    minBinId: range.minBinId,
    maxBinId: range.maxBinId,
    slippageBps: integer(flags, "slippage-bps", 100),
    ...(infrastructure(flags) ? { infrastructure: infrastructure(flags) } : {}),
  });

  process.stdout.write(
    `${flags.has("live") ? "OPEN" : "WOULD OPEN"}  ` +
      `${prepared.position ?? "new-position"}  range=${range.minBinId}..${range.maxBinId}  ` +
      `active=${target.activeBin}  candle=${target.candleLow}..${target.candleHigh}\n`,
  );

  if (!flags.has("live")) return prepared.position ?? null;
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

async function runCycle(
  slrd: Solard,
  flags: Flags,
  state: AgentState,
): Promise<void> {
  const walletRef = required(flags, "wallet");
  const pool = required(flags, "pool");
  const wallet = slrd.resolveWallet(walletRef).address.toBase58();
  const target = await previousClosedFiveMinuteTarget(slrd, pool, flags);
  let positions = await slrd.meteora.getPoolPositions(pool, wallet);
  const requestedPosition =
    state.managedPosition ?? flag(flags, "position") ?? null;

  if (requestedPosition) {
    positions = positions.filter((row) => row.position === requestedPosition);
    if (!positions.length && state.everManagedPosition) {
      throw new Error(
        `Managed position ${requestedPosition} disappeared. Refusing to inject fresh bootstrap capital automatically.`,
      );
    }
    if (!positions.length && flag(flags, "position")) {
      throw new Error(
        `Position ${requestedPosition} is not an open position for ${wallet} in pool ${pool}`,
      );
    }
  }

  if (!positions.length) {
    const hasBootstrapFunding = Boolean(
      flag(flags, "sol") ||
      flag(flags, "amount-x") ||
      flag(flags, "x") ||
      flag(flags, "amount-y") ||
      flag(flags, "y"),
    );
    if (state.bootstrapConsumed || state.everManagedPosition) {
      throw new Error(
        "No managed position is currently open. Refusing to bootstrap fresh capital again in the same agent process.",
      );
    }
    // Consume live bootstrap authorization before submission. If submission is
    // ambiguous or partially succeeds, the loop will never fund a second position.
    if (flags.has("live") && hasBootstrapFunding)
      state.bootstrapConsumed = true;
    const openedPosition = await bootstrapIfNeeded({
      slrd,
      flags,
      walletRef,
      pool,
      target,
    });
    if (flags.has("live") && openedPosition) {
      state.managedPosition = openedPosition;
      state.everManagedPosition = true;
    }
    return;
  }

  if (positions.length > 1 && !requestedPosition) {
    throw new Error(
      `Wallet has ${positions.length} positions in this pool. ` +
        "Pass --position <address> so the example agent cannot move unrelated positions.",
    );
  }

  const position = positions[0]!;
  state.managedPosition = position.position;
  state.everManagedPosition = true;
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
      `shift=${shift}  inventory=${inv}  ` +
      `candle=${new Date(target.candleTimestamp * 1_000).toISOString()} ` +
      `${target.candleLow}..${target.candleHigh}\n`,
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
  state.everManagedPosition = true;
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
      "Meteora previous-5m-candle liquidity agent example\n\n" +
        "Usage:\n" +
        "  slrd run examples/meteora-liquidity-agent.ts --pool <pool> --wallet <wallet> [--position <position>] [--loop] [--live]\n" +
        "  slrd run examples/meteora-liquidity-agent.ts --pool <pool> --wallet <wallet> --sol 0.1 --loop --live\n\n" +
        "If the wallet has no position in the pool, --sol or --amount-x/--amount-y bootstraps one.\n" +
        "Live Meteora writes also require SOLARD_ENABLE_LIVE_TRADES=1.\n",
    );
    return;
  }

  required(flags, "wallet");
  required(flags, "pool");
  const slrd = createTraderSolard();
  const state: AgentState = {
    managedPosition: flag(flags, "position") ?? null,
    bootstrapConsumed: false,
    everManagedPosition: false,
  };
  try {
    while (true) {
      try {
        await runCycle(slrd, flags, state);
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
