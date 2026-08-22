import type {
  MeteoraPreparedTransactions,
  MeteoraStrategy,
  MeteoraTimeframe,
  Solard,
} from "@solard/sdk";

const WSOL = "So11111111111111111111111111111111111111112";

type Flags = Map<string, string>;
type Emit = (value: string) => void;
type AnyRow = Record<string, any>;

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function flag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function requiredFlag(flags: Flags, key: string): string {
  const value = flag(flags, key);
  if (!value) throw new Error(`Missing --${key} <value>`);
  return value;
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

function integerFlag(
  flags: Flags,
  key: string,
  fallback?: number,
): number | undefined {
  const value = numberFlag(flags, key, fallback);
  if (value == null) return undefined;
  if (!Number.isInteger(value)) throw new Error(`--${key} must be an integer`);
  return value;
}

function positiveIntegerFlag(
  flags: Flags,
  key: string,
  fallback?: number,
): number | undefined {
  const value = integerFlag(flags, key, fallback);
  if (value == null) return undefined;
  if (value <= 0) throw new Error(`--${key} must be > 0`);
  return value;
}

function timeframe(
  flags: Flags,
  fallback: MeteoraTimeframe = "30m",
): MeteoraTimeframe {
  const value = flag(flags, "timeframe") ?? flag(flags, "interval") ?? fallback;
  if (!["5m", "30m", "1h", "2h", "4h", "12h", "24h"].includes(value)) {
    throw new Error(
      "Meteora timeframe must be 5m, 30m, 1h, 2h, 4h, 12h, or 24h",
    );
  }
  return value as MeteoraTimeframe;
}

function strategy(flags: Flags): MeteoraStrategy {
  const value = flag(flags, "strategy") ?? "spot";
  if (value !== "spot" && value !== "bid_ask" && value !== "curve") {
    throw new Error("--strategy must be spot, bid_ask, or curve");
  }
  return value;
}

function publicWalletAddress(slrd: Solard, ref: string): string {
  try {
    return slrd.resolveWallet(ref).address.toBase58();
  } catch {
    // Read-only Meteora endpoints accept a raw public address. The downstream
    // PublicKey parser remains the authoritative validator.
    return ref.trim();
  }
}

function preparedSummary(prepared: MeteoraPreparedTransactions) {
  return {
    prepared: true,
    live: false,
    kind: prepared.kind,
    pool: prepared.pool,
    position: prepared.position ?? null,
    transactionCount: prepared.transactions.length,
    extraSignerCount: prepared.extraSigners.length,
    metadata: prepared.metadata ?? null,
    note:
      prepared.kind === "open-position"
        ? "Prepared only. The generated position key is ephemeral; rebuilding later may produce a different position address. Add --live to build, simulate, and broadcast in one invocation."
        : "Prepared only. Add --live to simulate and broadcast.",
  };
}

async function finishWrite(
  slrd: Solard,
  prepared: MeteoraPreparedTransactions,
  flags: Flags,
): Promise<unknown> {
  if (!flags.has("live")) return preparedSummary(prepared);
  return await slrd.meteora.executePrepared(prepared, {
    live: true,
    simulate: !flags.has("skip-simulation"),
    skipPreflight: flags.has("skip-preflight"),
    commitment: (flag(flags, "commitment") as any) ?? "confirmed",
    maxRetries: integerFlag(flags, "max-retries"),
  });
}

function appendFilter(parts: string[], expression: string | undefined): void {
  const clean = expression?.trim();
  if (clean) parts.push(clean);
}

function poolSort(flags: Flags, tf: MeteoraTimeframe): string | undefined {
  const sort = flag(flags, "sort");
  if (!sort) return undefined;
  const direction = (flag(flags, "direction") ?? "desc").toLowerCase();
  if (direction !== "asc" && direction !== "desc") {
    throw new Error("--direction must be asc or desc");
  }
  if (sort.includes(":")) return sort;
  if (sort === "fee-active-tvl") {
    throw new Error(
      "fee-active-tvl is a Pool Discovery metric. Use: slrd meteora discover --timeframe <window> --sort fee-active-tvl",
    );
  }
  if (sort === "fee-tvl" || sort === "fee-tvl-ratio") {
    return `fee_tvl_ratio_${tf}:${direction}`;
  }
  if (sort === "volume") return `volume_${tf}:${direction}`;
  if (sort === "tvl") return `tvl:${direction}`;
  return `${sort}:${direction}`;
}

function listRows(payload: unknown): AnyRow[] {
  if (Array.isArray(payload)) return payload as AnyRow[];
  const row = payload as AnyRow | null;
  if (Array.isArray(row?.data)) return row!.data;
  if (Array.isArray(row?.pools)) return row!.pools;
  return [];
}

function pickMetric(row: AnyRow, key: string, tf: MeteoraTimeframe): unknown {
  return (
    row?.[`${key}_${tf}`] ??
    row?.[key]?.[tf] ??
    row?.metrics?.[key]?.[tf] ??
    null
  );
}

function poolTable(payload: unknown, tf: MeteoraTimeframe): string {
  const rows = listRows(payload);
  if (!rows.length) return json(payload) + "\n";
  const lines = [
    "POOL\tNAME\tFEE/TVL\tVOLUME\tTVL\tBIN",
    ...rows.map((row) => {
      const address = String(row.address ?? row.pool_address ?? row.pool ?? "");
      const ratio = pickMetric(row, "fee_tvl_ratio", tf);
      const volume = pickMetric(row, "volume", tf);
      const tvl = row.active_tvl ?? row.tvl ?? row.liquidity ?? null;
      const bin =
        row.bin_step ??
        row.dlmm_params?.bin_step ??
        row.pool_config?.bin_step ??
        null;
      return [
        address,
        String(row.name ?? ""),
        ratio == null ? "" : String(ratio),
        volume == null ? "" : String(volume),
        tvl == null ? "" : String(tvl),
        bin == null ? "" : String(bin),
      ].join("\t");
    }),
  ];
  return lines.join("\n") + "\n";
}

function discoveryAddress(row: AnyRow): string {
  return String(row.pool_address ?? row.address ?? row.pool ?? "");
}

function finiteMetric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usd(value: unknown): string {
  const amount = finiteMetric(value);
  if (amount == null) return "-";
  const absolute = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (absolute >= 1_000_000_000)
    return `${sign}$${(absolute / 1_000_000_000).toFixed(2)}B`;
  if (absolute >= 1_000_000)
    return `${sign}$${(absolute / 1_000_000).toFixed(2)}M`;
  if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(2)}K`;
  return `${sign}$${absolute.toFixed(2)}`;
}

function percentRatio(value: unknown): string {
  // Pool Discovery already reports fee_active_tvl_ratio in percentage units.
  // Example: fee=$6.75K and active_tvl=$37.21K => 18.14, not 0.1814.
  const percent = finiteMetric(value);
  if (percent == null) return "-";
  return `${percent.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

function pad(
  value: unknown,
  width: number,
  align: "left" | "right" = "left",
): string {
  const text = String(value ?? "");
  if (text.length >= width) return text.slice(0, width);
  return align === "right" ? text.padStart(width) : text.padEnd(width);
}

function discoveryIdentity(row: AnyRow): string {
  const address = discoveryAddress(row).trim();
  if (address) return address;
  return JSON.stringify([
    row.name ?? null,
    row.token_x?.address ?? null,
    row.token_y?.address ?? null,
  ]);
}

function sameDiscoveryPage(a: AnyRow[], b: AnyRow[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return a.every(
    (row, index) => discoveryIdentity(row) === discoveryIdentity(b[index]),
  );
}

function discoveryTable(rows: AnyRow[], timeframe: MeteoraTimeframe): string {
  if (!rows.length) return "No discovery pools matched.\n";
  const feeLabel = `FEE ${timeframe.toUpperCase()}`;
  const volumeLabel = `VOLUME ${timeframe.toUpperCase()}`;
  const header = [
    pad("NAME", 22),
    pad("FEE/ACTIVE", 12, "right"),
    pad(feeLabel, 12, "right"),
    pad("ACTIVE TVL", 12, "right"),
    pad("TOTAL TVL", 12, "right"),
    pad(volumeLabel, 12, "right"),
    pad("BIN", 5, "right"),
    "POOL",
  ].join("  ");
  const body = rows.map((row) =>
    [
      pad(String(row.name ?? "-"), 22),
      pad(percentRatio(row.fee_active_tvl_ratio), 12, "right"),
      pad(usd(row.fee), 12, "right"),
      pad(usd(row.active_tvl), 12, "right"),
      pad(usd(row.tvl), 12, "right"),
      pad(usd(row.volume), 12, "right"),
      pad(row.dlmm_params?.bin_step ?? row.bin_step ?? "-", 5, "right"),
      discoveryAddress(row),
    ].join("  "),
  );
  return [header, ...body].join("\n") + "\n";
}

async function resolvePositionPool(
  slrd: Solard,
  position: string,
  flags: Flags,
): Promise<{ pool: string; walletAddress?: string }> {
  const explicit = flag(flags, "pool");
  const walletRef = flag(flags, "wallet");
  const walletAddress = walletRef
    ? publicWalletAddress(slrd, walletRef)
    : undefined;
  if (explicit) return { pool: explicit, walletAddress };
  if (!walletAddress) {
    throw new Error(
      "Position command needs --wallet <stored-wallet|public-address> to resolve its pool, or pass --pool <pool-address> explicitly.",
    );
  }
  return {
    pool: await slrd.meteora.findPoolForPosition(position, walletAddress),
    walletAddress,
  };
}

function rangeArgs(flags: Flags): {
  minBinId?: number;
  maxBinId?: number;
  binsBelow?: number;
  binsAbove?: number;
  downsidePct?: number;
  upsidePct?: number;
} {
  return {
    minBinId: integerFlag(flags, "min-bin"),
    maxBinId: integerFlag(flags, "max-bin"),
    binsBelow: integerFlag(flags, "bins-below"),
    binsAbove: integerFlag(flags, "bins-above"),
    downsidePct: numberFlag(flags, "downside-pct"),
    upsidePct: numberFlag(flags, "upside-pct"),
  };
}

async function openPosition(
  slrd: Solard,
  pool: string,
  flags: Flags,
): Promise<unknown> {
  const wallet = requiredFlag(flags, "wallet");
  const solAmount = flag(flags, "sol");
  const amountX = flag(flags, "x") ?? flag(flags, "amount-x");
  const amountY = flag(flags, "y") ?? flag(flags, "amount-y");
  const suppliedAmounts = [solAmount, amountX, amountY].filter(
    (value) => value != null,
  ).length;
  if (suppliedAmounts !== 1) {
    throw new Error(
      "Supply exactly one of --sol <amount>, --x <amount>, or --y <amount>",
    );
  }

  const range = rangeArgs(flags);
  const shorthandBins = positiveIntegerFlag(flags, "bins");
  let x = amountX;
  let y = amountY;

  if (solAmount != null) {
    const state = await slrd.meteora.getPoolState(pool, true);
    const xIsSol = state.tokenX.mint === WSOL;
    const yIsSol = state.tokenY.mint === WSOL;
    if (!xIsSol && !yIsSol) {
      throw new Error(
        "--sol can only be used when one side of the DLMM pool is wrapped SOL; use --x or --y for other pairs.",
      );
    }
    if (xIsSol) x = solAmount;
    else y = solAmount;

    if (shorthandBins != null) {
      const explicitRange = Object.values(range).some((value) => value != null);
      if (explicitRange) {
        throw new Error(
          "Use either --bins shorthand or explicit range flags, not both",
        );
      }
      if (xIsSol) {
        range.binsBelow = 0;
        range.binsAbove = shorthandBins;
      } else {
        range.binsBelow = shorthandBins;
        range.binsAbove = 0;
      }
    }
  } else if (shorthandBins != null) {
    throw new Error(
      "--bins shorthand is only available with --sol; use --bins-below/--bins-above otherwise",
    );
  }

  if (!Object.values(range).some((value) => value != null)) {
    throw new Error(
      "A DLMM range is required. Use --bins N with --sol, or explicit --bins-below/--bins-above, --min-bin/--max-bin, or --downside-pct/--upside-pct.",
    );
  }

  const prepared = await slrd.meteora.buildOpenPosition({
    wallet,
    pool,
    strategy: strategy(flags),
    amountX: x,
    amountY: y,
    ...range,
    slippageBps: integerFlag(flags, "slippage-bps", 100),
  });
  return await finishWrite(slrd, prepared, flags);
}

async function addLiquidity(
  slrd: Solard,
  position: string,
  flags: Flags,
): Promise<unknown> {
  const wallet = requiredFlag(flags, "wallet");
  const { pool } = await resolvePositionPool(slrd, position, flags);
  const solAmount = flag(flags, "sol");
  let amountX = flag(flags, "x") ?? flag(flags, "amount-x");
  let amountY = flag(flags, "y") ?? flag(flags, "amount-y");
  const supplied = [solAmount, amountX, amountY].filter(
    (value) => value != null,
  ).length;
  if (supplied !== 1) {
    throw new Error(
      "Supply exactly one of --sol <amount>, --x <amount>, or --y <amount>",
    );
  }
  if (solAmount != null) {
    const state = await slrd.meteora.getPoolState(pool, true);
    if (state.tokenX.mint === WSOL) amountX = solAmount;
    else if (state.tokenY.mint === WSOL) amountY = solAmount;
    else throw new Error("--sol requires a pool containing wrapped SOL");
  }
  const existing = await slrd.meteora.getPosition(pool, position);
  const prepared = await slrd.meteora.buildAddLiquidity({
    wallet,
    pool,
    position,
    strategy: strategy(flags),
    amountX,
    amountY,
    minBinId: integerFlag(flags, "min-bin", existing.lowerBin ?? undefined),
    maxBinId: integerFlag(flags, "max-bin", existing.upperBin ?? undefined),
    slippageBps: integerFlag(flags, "slippage-bps", 100),
  });
  return await finishWrite(slrd, prepared, flags);
}

function exactDirection(flags: Flags): {
  kind: "in" | "out";
  swapForY: boolean;
  amount: string;
} {
  const choices = [
    ["in-x", "in", true],
    ["in-y", "in", false],
    ["out-y", "out", true],
    ["out-x", "out", false],
  ] as const;
  const selected = choices.filter(([key]) => flag(flags, key) != null);
  if (selected.length !== 1) {
    throw new Error(
      "Supply exactly one of --in-x, --in-y, --out-x, or --out-y",
    );
  }
  const [key, kind, swapForY] = selected[0]!;
  return { kind, swapForY, amount: flag(flags, key)! };
}

export async function handleMeteoraCommand(args: {
  slrd: Solard;
  values: string[];
  flags: Flags;
  emit: Emit;
}): Promise<void> {
  const { slrd, values, flags, emit } = args;
  const action = values[0] ?? "help";

  if (action === "help") {
    emit(
      `Meteora DLMM\n\n` +
        `Read\n` +
        `  slrd meteora discover [--timeframe 30m] [--category all|top|new|trending] [--sort fee-active-tvl] [--limit 20] [--min-active-tvl N] [--min-volume N] [--page-size 100]\n` +
        `  slrd meteora pools [--timeframe 30m] [--sort fee-tvl|volume|tvl] [--limit 20] [--min-tvl N] [--min-volume N]\n` +
        `  slrd meteora pool <pool> [--timeframe 30m]\n` +
        `  slrd meteora candles <pool> [--timeframe 5m] [--start-time unix] [--end-time unix]\n` +
        `  slrd meteora active-bin <pool>\n` +
        `  slrd meteora positions --wallet <wallet|address> [--pool <pool>]\n` +
        `  slrd meteora position <position> (--wallet <wallet|address> | --pool <pool>)\n` +
        `  slrd meteora portfolio --wallet <wallet|address> [--open]\n` +
        `  slrd meteora history <position>\n` +
        `  slrd meteora stats [--series protocol-fees|trading-fees|volume]\n` +
        `  slrd meteora quote <pool> (--in-x N|--in-y N|--out-x N|--out-y N) [--slippage-bps 100]\n\n` +
        `Positions / swaps (prepare-only unless --live)\n` +
        `  slrd meteora open|create <pool> --wallet <wallet> --sol N --bins 40 [--strategy spot] [--live]\n` +
        `  slrd meteora add <position> --wallet <wallet> --sol N [--pool <pool>] [--live]\n` +
        `  slrd meteora remove <position> --wallet <wallet> [--bps 10000] [--pool <pool>] [--live]\n` +
        `  slrd meteora close <position> --wallet <wallet> [--pool <pool>] [--live]\n` +
        `  slrd meteora claim <position> --wallet <wallet> [--kind fees|rewards|all] [--pool <pool>] [--live]\n` +
        `  slrd meteora claim-all <pool> --wallet <wallet> [--kind fees|rewards|all] [--live]\n` +
        `  slrd meteora swap <pool> --wallet <wallet> (--in-x N|--in-y N|--out-x N|--out-y N) [--live]\n\n` +
        `--live still requires SOLARD_ENABLE_LIVE_TRADES=1. Live sends simulate first and keep preflight enabled unless explicitly skipped.\n`,
    );
    return;
  }

  if (action === "discover") {
    const tf = timeframe(flags, "30m");
    const categoryFlag = flag(flags, "category");
    const category = categoryFlag === "all" ? undefined : categoryFlag;
    if (category && !["top", "new", "trending"].includes(category)) {
      throw new Error("--category must be all, top, new, or trending");
    }

    const limit = Math.max(
      1,
      Math.min(100, positiveIntegerFlag(flags, "limit", 20)!),
    );
    // Pool Discovery behaves as a ranked feed, not a paginated list: page=2 is
    // currently ignored. Request a wider single feed than the displayed limit
    // so local threshold checks still have headroom.
    const pageSize = Math.max(
      limit,
      Math.min(100, positiveIntegerFlag(flags, "page-size", 100)!),
    );

    const sort = flag(flags, "sort") ?? "fee-active-tvl";
    const direction = (flag(flags, "direction") ?? "desc").toLowerCase();
    if (direction !== "asc" && direction !== "desc") {
      throw new Error("--direction must be asc or desc");
    }
    const field =
      sort === "fee-active-tvl"
        ? "fee_active_tvl_ratio"
        : sort === "volume"
          ? "volume"
          : sort === "fee"
            ? "fee"
            : sort === "active-tvl"
              ? "active_tvl"
              : sort === "tvl"
                ? "tvl"
                : null;
    if (!field) {
      throw new Error(
        "--sort for discover must be fee-active-tvl, fee, volume, active-tvl, or tvl",
      );
    }

    const baseFilters: string[] = ["pool_type=dlmm"];
    appendFilter(baseFilters, flag(flags, "filter"));
    const minTvl = numberFlag(flags, "min-tvl");
    const minActiveTvl = numberFlag(flags, "min-active-tvl");
    const minVolume = numberFlag(flags, "min-volume");
    if (minTvl != null) baseFilters.push(`tvl>=${minTvl}`);
    if (minVolume != null) baseFilters.push(`volume>=${minVolume}`);

    let activeTvlFilterMode: "server" | "local-fallback" = "server";
    let requestFilters = [...baseFilters];
    if (minActiveTvl != null)
      requestFilters.push(`active_tvl>=${minActiveTvl}`);
    let appliedFilterBy = requestFilters.join("&&");

    const fetchFeed = async () =>
      await slrd.meteora.discoverPools({
        pageSize,
        timeframe: tf,
        category: category as any,
        filterBy: appliedFilterBy,
      });

    let feed: Awaited<ReturnType<typeof slrd.meteora.discoverPools>>;
    try {
      feed = await fetchFeed();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const filterRejected = /HTTP (?:400|422)\b/.test(message);
      if (minActiveTvl == null || !filterRejected) throw error;
      activeTvlFilterMode = "local-fallback";
      appliedFilterBy = baseFilters.join("&&");
      feed = await fetchFeed();
    }

    let rows = [...(feed.pools as AnyRow[])];
    if (minActiveTvl != null) {
      rows = rows.filter((row) => {
        const activeTvl = finiteMetric(row.active_tvl);
        return activeTvl != null && activeTvl >= minActiveTvl;
      });
    }
    if (minVolume != null) {
      rows = rows.filter((row) => {
        const volume = finiteMetric(row.volume);
        return volume != null && volume >= minVolume;
      });
    }
    if (minTvl != null) {
      rows = rows.filter((row) => {
        const tvl = finiteMetric(row.tvl);
        return tvl != null && tvl >= minTvl;
      });
    }

    const factor = direction === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const av = finiteMetric(a[field]);
      const bv = finiteMetric(b[field]);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * factor;
    });
    rows = rows.slice(0, limit);

    const result = {
      timeframe: tf,
      category: category ?? "all",
      sort: `${field}:${direction}`,
      rankingMode: "pool-discovery-ranked-feed",
      rankingScope: `single discovery feed (page_size=${pageSize}); Pool Discovery currently ignores page=2`,
      filterBy: appliedFilterBy,
      activeTvlFilterMode,
      reportedTotal: feed.total,
      feedSize: feed.pools.length,
      returned: rows.length,
      pools: rows,
    };
    emit(flags.has("json") ? json(result) + "\n" : discoveryTable(rows, tf));
    return;
  }

  if (action === "pools") {
    const tf = timeframe(flags, "30m");
    const filters: string[] = [];
    appendFilter(filters, flag(flags, "filter"));
    const minTvl = numberFlag(flags, "min-tvl");
    const minVolume = numberFlag(flags, "min-volume");
    if (flags.has("min-active-tvl")) {
      throw new Error(
        "--min-active-tvl belongs to the Pool Discovery API. Use slrd meteora discover instead.",
      );
    }
    if (minTvl != null) filters.push(`tvl>=${minTvl}`);
    if (minVolume != null) filters.push(`volume_${tf}>=${minVolume}`);
    if (flags.has("exclude-blacklisted")) filters.push("is_blacklisted=false");

    const payload = await slrd.meteora.listPools({
      page: positiveIntegerFlag(flags, "page", 1),
      pageSize: positiveIntegerFlag(flags, "limit", 20),
      query: flag(flags, "query"),
      sortBy: poolSort(flags, tf),
      filterBy: filters.length ? filters.join(" && ") : undefined,
      volumeTw: tf,
      feeTvlRatioTw: tf,
    });
    emit(flags.has("json") ? json(payload) + "\n" : poolTable(payload, tf));
    return;
  }

  if (action === "pool") {
    const pool = values[1];
    if (!pool)
      throw new Error("Usage: slrd meteora pool <pool> [--timeframe 30m]");
    const tf = timeframe(flags, "30m");
    const [onChain, indexed, discovery] = await Promise.all([
      slrd.meteora.getPoolState(pool, true),
      slrd.meteora.getIndexedPool(pool).catch(() => null),
      slrd.meteora.getPoolDetail(pool, tf).catch(() => null),
    ]);
    emit(json({ pool, timeframe: tf, onChain, indexed, discovery }) + "\n");
    return;
  }

  if (action === "candles") {
    const pool = values[1];
    if (!pool)
      throw new Error("Usage: slrd meteora candles <pool> [--timeframe 5m]");
    emit(
      json(
        await slrd.meteora.getPoolOhlcv(pool, {
          timeframe: timeframe(flags, "5m"),
          startTime: numberFlag(flags, "start-time"),
          endTime: numberFlag(flags, "end-time"),
        }),
      ) + "\n",
    );
    return;
  }

  if (action === "active-bin") {
    const pool = values[1];
    if (!pool) throw new Error("Usage: slrd meteora active-bin <pool>");
    emit(json(await slrd.meteora.getActiveBin(pool, true)) + "\n");
    return;
  }

  if (action === "positions") {
    const walletRef = requiredFlag(flags, "wallet");
    const wallet = publicWalletAddress(slrd, walletRef);
    const pool = flag(flags, "pool");
    const result = pool
      ? await slrd.meteora.getPoolPositions(pool, wallet)
      : await slrd.meteora.getWalletPositions(wallet);
    emit(json(result) + "\n");
    return;
  }

  if (action === "position") {
    const position = values[1];
    if (!position)
      throw new Error(
        "Usage: slrd meteora position <position> (--wallet <wallet|address> | --pool <pool>)",
      );
    const { pool } = await resolvePositionPool(slrd, position, flags);
    emit(json(await slrd.meteora.getPosition(pool, position)) + "\n");
    return;
  }

  if (action === "portfolio") {
    const wallet = publicWalletAddress(slrd, requiredFlag(flags, "wallet"));
    const page = positiveIntegerFlag(flags, "page", 1);
    const pageSize = positiveIntegerFlag(flags, "limit", 50);
    const result = flags.has("open")
      ? await slrd.meteora.getOpenPortfolio({
          user: wallet,
          page,
          pageSize,
          sortDirection: (flag(flags, "direction") as any) ?? "desc",
          sortBy: flag(flags, "sort") as any,
        })
      : await slrd.meteora.getPortfolio({
          user: wallet,
          page,
          pageSize,
          daysBack: numberFlag(flags, "days-back"),
        });
    emit(json(result) + "\n");
    return;
  }

  if (action === "history") {
    const position = values[1];
    if (!position) throw new Error("Usage: slrd meteora history <position>");
    emit(
      json(
        await slrd.meteora.getPositionHistory(position, {
          eventType: flag(flags, "event-type") as any,
          orderDirection: flag(flags, "direction") as any,
          page: positiveIntegerFlag(flags, "page", 1),
          pageSize: positiveIntegerFlag(flags, "limit", 50),
        }),
      ) + "\n",
    );
    return;
  }

  if (action === "stats") {
    const series = flag(flags, "series");
    const result =
      series === "protocol-fees"
        ? await slrd.meteora.getDailyProtocolFees()
        : series === "trading-fees"
          ? await slrd.meteora.getDailyTradingFees()
          : series === "volume"
            ? await slrd.meteora.getDailyVolume()
            : await slrd.meteora.getProtocolMetrics();
    if (
      series &&
      !["protocol-fees", "trading-fees", "volume"].includes(series)
    ) {
      throw new Error(
        "--series must be protocol-fees, trading-fees, or volume",
      );
    }
    emit(json(result) + "\n");
    return;
  }

  if (action === "quote") {
    const pool = values[1];
    if (!pool)
      throw new Error(
        "Usage: slrd meteora quote <pool> (--in-x N|--in-y N|--out-x N|--out-y N)",
      );
    const direction = exactDirection(flags);
    const slippageBps = integerFlag(flags, "slippage-bps", 100);
    const result =
      direction.kind === "in"
        ? await slrd.meteora.quoteSwapExactIn({
            pool,
            swapForY: direction.swapForY,
            amountIn: direction.amount,
            slippageBps,
            allowPartialFill: flags.has("allow-partial-fill"),
            maxExtraBinArrays: integerFlag(flags, "max-extra-bin-arrays"),
          })
        : await slrd.meteora.quoteSwapExactOut({
            pool,
            swapForY: direction.swapForY,
            amountOut: direction.amount,
            slippageBps,
            maxExtraBinArrays: integerFlag(flags, "max-extra-bin-arrays"),
          });
    emit(json(result) + "\n");
    return;
  }

  if (action === "open" || action === "create") {
    const pool = values[1];
    if (!pool)
      throw new Error(
        `Usage: slrd meteora ${action} <pool> --wallet <wallet> ...`,
      );
    emit(json(await openPosition(slrd, pool, flags)) + "\n");
    return;
  }

  if (action === "add") {
    const position = values[1];
    if (!position)
      throw new Error(
        "Usage: slrd meteora add <position> --wallet <wallet> --sol N [--live]",
      );
    emit(json(await addLiquidity(slrd, position, flags)) + "\n");
    return;
  }

  if (action === "remove") {
    const position = values[1];
    if (!position)
      throw new Error(
        "Usage: slrd meteora remove <position> --wallet <wallet> [--bps 10000] [--live]",
      );
    const wallet = requiredFlag(flags, "wallet");
    const { pool } = await resolvePositionPool(slrd, position, flags);
    const prepared = await slrd.meteora.buildRemoveLiquidity({
      wallet,
      pool,
      position,
      bps: integerFlag(flags, "bps", 10_000),
      fromBinId: integerFlag(flags, "from-bin"),
      toBinId: integerFlag(flags, "to-bin"),
      claimAndClose: flags.has("claim-and-close"),
      skipUnwrapSol: flags.has("skip-unwrap-sol"),
    });
    emit(json(await finishWrite(slrd, prepared, flags)) + "\n");
    return;
  }

  if (action === "close") {
    const position = values[1];
    if (!position)
      throw new Error(
        "Usage: slrd meteora close <position> --wallet <wallet> [--live]",
      );
    const wallet = requiredFlag(flags, "wallet");
    const { pool } = await resolvePositionPool(slrd, position, flags);
    const prepared = await slrd.meteora.buildClosePosition({
      wallet,
      pool,
      position,
    });
    emit(json(await finishWrite(slrd, prepared, flags)) + "\n");
    return;
  }

  if (action === "claim") {
    const position = values[1];
    if (!position)
      throw new Error(
        "Usage: slrd meteora claim <position> --wallet <wallet> [--kind fees|rewards|all] [--live]",
      );
    const wallet = requiredFlag(flags, "wallet");
    const { pool } = await resolvePositionPool(slrd, position, flags);
    const kind = flag(flags, "kind") ?? "all";
    const prepared =
      kind === "fees"
        ? await slrd.meteora.buildClaimFees({ wallet, pool, position })
        : kind === "rewards"
          ? await slrd.meteora.buildClaimRewards({ wallet, pool, position })
          : kind === "all"
            ? await slrd.meteora.buildClaimPositionRewards({
                wallet,
                pool,
                position,
              })
            : null;
    if (!prepared) throw new Error("--kind must be fees, rewards, or all");
    emit(json(await finishWrite(slrd, prepared, flags)) + "\n");
    return;
  }

  if (action === "claim-all") {
    const pool = values[1];
    if (!pool)
      throw new Error(
        "Usage: slrd meteora claim-all <pool> --wallet <wallet> [--kind fees|rewards|all] [--live]",
      );
    const wallet = requiredFlag(flags, "wallet");
    const kind = flag(flags, "kind") ?? "all";
    const prepared =
      kind === "fees"
        ? await slrd.meteora.buildClaimAllFees({ wallet, pool })
        : kind === "rewards"
          ? await slrd.meteora.buildClaimAllLmRewards({ wallet, pool })
          : kind === "all"
            ? await slrd.meteora.buildClaimAllRewards({ wallet, pool })
            : null;
    if (!prepared) throw new Error("--kind must be fees, rewards, or all");
    emit(json(await finishWrite(slrd, prepared, flags)) + "\n");
    return;
  }

  if (action === "swap") {
    const pool = values[1];
    if (!pool)
      throw new Error(
        "Usage: slrd meteora swap <pool> --wallet <wallet> (--in-x N|--in-y N|--out-x N|--out-y N) [--live]",
      );
    const wallet = requiredFlag(flags, "wallet");
    const direction = exactDirection(flags);
    const slippageBps = integerFlag(flags, "slippage-bps", 100);
    const prepared =
      direction.kind === "in"
        ? await slrd.meteora.buildSwapExactIn({
            wallet,
            pool,
            swapForY: direction.swapForY,
            amountIn: direction.amount,
            slippageBps,
            allowPartialFill: flags.has("allow-partial-fill"),
            maxExtraBinArrays: integerFlag(flags, "max-extra-bin-arrays"),
          })
        : await slrd.meteora.buildSwapExactOut({
            wallet,
            pool,
            swapForY: direction.swapForY,
            amountOut: direction.amount,
            slippageBps,
            maxExtraBinArrays: integerFlag(flags, "max-extra-bin-arrays"),
          });
    emit(json(await finishWrite(slrd, prepared, flags)) + "\n");
    return;
  }

  throw new Error(`Unknown Meteora command: ${action}. Run: slrd meteora help`);
}
