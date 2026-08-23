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

function shortId(value: unknown, head = 6, tail = 6): string {
  const text = String(value ?? "");
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function rawUiText(raw: unknown, decimals: unknown, precision = 6): string {
  const text = String(raw ?? "0");
  const d = Number(decimals ?? 0);
  if (!/^\d+$/.test(text) || !Number.isInteger(d) || d < 0) return text;
  const value = BigInt(text);
  if (d === 0) return value.toString();
  const scale = 10n ** BigInt(d);
  const whole = value / scale;
  const frac = (value % scale)
    .toString()
    .padStart(d, "0")
    .slice(0, Math.min(d, precision))
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function numberText(value: unknown, digits = 6): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (n === 0) return "0";
  if (Math.abs(n) >= 1_000)
    return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: digits });
}

function poolDetailText(payload: AnyRow): string {
  const on = payload.onChain ?? {};
  const indexed = payload.indexed ?? {};
  const discovery = payload.discovery ?? {};
  const x = indexed.token_x ?? discovery.token_x ?? on.tokenX ?? {};
  const y = indexed.token_y ?? discovery.token_y ?? on.tokenY ?? {};
  const tf = String(payload.timeframe ?? "30m");
  const volume = indexed.volume?.[tf] ?? discovery.volume ?? null;
  const fees = indexed.fees?.[tf] ?? discovery.fee ?? null;
  const activeTvl = discovery.active_tvl ?? null;
  const totalTvl = discovery.tvl ?? indexed.tvl ?? null;
  const lines = [
    `POOL     ${indexed.name ?? discovery.name ?? shortId(payload.pool)}  ${payload.pool}`,
    `PAIR     ${x.symbol ?? x.name ?? shortId(x.address ?? on.tokenX?.mint)} / ${y.symbol ?? y.name ?? shortId(y.address ?? on.tokenY?.mint)}`,
    `ACTIVE   bin=${on.activeId ?? on.activeBin?.binId ?? "-"}  price=${numberText(on.activeBin?.price ?? indexed.current_price ?? discovery.pool_price, 8)}  bin-step=${on.binStep ?? indexed.pool_config?.bin_step ?? discovery.dlmm_params?.bin_step ?? "-"}`,
    `FEES     base=${numberText(indexed.pool_config?.base_fee_pct ?? discovery.fee_pct, 5)}%  dynamic=${numberText(indexed.dynamic_fee_pct ?? discovery.dynamic_fee_pct, 5)}%  ${tf}=${usd(fees)}`,
    `FLOW     volume=${usd(volume)}  active=${usd(activeTvl)}  total=${usd(totalTvl)}  fee/active=${percentRatio(discovery.fee_active_tvl_ratio)}`,
  ];
  if (x.holders != null || discovery.base_token_holders != null) {
    lines.push(
      `TOKEN    holders=${Number(x.holders ?? discovery.base_token_holders).toLocaleString("en-US")}  verified=${x.is_verified ?? "-"}  top-holders=${x.top_holders_pct == null ? "-" : `${numberText(x.top_holders_pct, 5)}%`}  dev=${x.dev_balance_pct == null ? "-" : `${numberText(x.dev_balance_pct, 5)}%`}`,
    );
  }
  if (discovery.swap_count != null) {
    lines.push(
      `ACTIVITY swaps=${discovery.swap_count}  traders=${discovery.unique_traders ?? "-"}  LPs=${discovery.unique_lps ?? "-"}  price-change=${discovery.pool_price_change_pct == null ? "-" : `${numberText(discovery.pool_price_change_pct, 5)}%`}`,
    );
  }
  return lines.join("\n") + "\n";
}

function candlesTable(payload: AnyRow): string {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  if (!rows.length) return `No ${payload?.timeframe ?? ""} candles.\n`;
  const lines = [
    [
      pad("TIME", 20),
      pad("OPEN", 14, "right"),
      pad("HIGH", 14, "right"),
      pad("LOW", 14, "right"),
      pad("CLOSE", 14, "right"),
      pad("VOLUME", 12, "right"),
    ].join("  "),
  ];
  for (const row of rows) {
    const time = String(row.timestamp_str ?? row.timestamp ?? "").replace(
      "+00:00",
      "Z",
    );
    lines.push(
      [
        pad(time, 20),
        pad(numberText(row.open, 7), 14, "right"),
        pad(numberText(row.high, 7), 14, "right"),
        pad(numberText(row.low, 7), 14, "right"),
        pad(numberText(row.close, 7), 14, "right"),
        pad(usd(row.volume), 12, "right"),
      ].join("  "),
    );
  }
  return lines.join("\n") + "\n";
}

function activeBinText(row: AnyRow): string {
  return `ACTIVE BIN  ${row.binId ?? "-"}  price=${numberText(row.price, 9)}  pool=${row.pool ?? "-"}\n`;
}

function positionsTable(result: AnyRow): string {
  const rows = Array.isArray(result?.positions) ? result.positions : [];
  if (!rows.length) return `METEORA POSITIONS 0\n`;
  const lines = [
    `METEORA POSITIONS ${rows.length}${result.wallet ? `  wallet=${result.wallet}` : ""}`,
    [
      pad("POSITION", 15),
      pad("RANGE", 14),
      pad("ACTIVE", 7, "right"),
      pad("IN", 3),
      pad("X", 16, "right"),
      pad("Y", 14, "right"),
      pad("FEE X", 12, "right"),
      pad("FEE Y", 12, "right"),
    ].join("  "),
  ];
  for (const row of rows) {
    const xd = row.tokenX?.decimals ?? 0;
    const yd = row.tokenY?.decimals ?? 0;
    lines.push(
      [
        pad(shortId(row.position, 7, 7), 15),
        pad(`${row.lowerBin ?? "?"}..${row.upperBin ?? "?"}`, 14),
        pad(row.activeBin ?? "-", 7, "right"),
        pad(row.inRange ? "yes" : "no", 3),
        pad(rawUiText(row.totalXRaw ?? row.xRaw, xd), 16, "right"),
        pad(rawUiText(row.totalYRaw ?? row.yRaw, yd), 14, "right"),
        pad(rawUiText(row.feeXRaw, xd), 12, "right"),
        pad(rawUiText(row.feeYRaw, yd), 12, "right"),
      ].join("  "),
    );
  }
  return lines.join("\n") + "\n";
}

function portfolioText(result: AnyRow): string {
  const total = result?.total ?? {};
  const lines = [
    `METEORA PORTFOLIO  positions=${result?.totalPositions ?? total.totalPositions ?? 0}  value=${numberText(total.balancesSol, 7)} SOL  fees=${numberText(total.unclaimedFeesSol, 7)} SOL  pnl=${numberText(total.pnlSol, 7)} SOL (${numberText(total.pnlSolPctChange, 5)}%)`,
  ];
  const pools = Array.isArray(result?.pools) ? result.pools : [];
  if (pools.length) {
    lines.push(
      [
        pad("POOL", 15),
        pad("PAIR", 20),
        pad("POS", 4, "right"),
        pad("VALUE SOL", 11, "right"),
        pad("FEES SOL", 10, "right"),
        pad("PNL SOL", 10, "right"),
        pad("OOR", 3),
      ].join("  "),
    );
    for (const row of pools) {
      lines.push(
        [
          pad(shortId(row.poolAddress, 7, 7), 15),
          pad(`${row.tokenX ?? "?"}-${row.tokenY ?? "?"}`, 20),
          pad(row.openPositionCount ?? "-", 4, "right"),
          pad(numberText(row.balancesSol, 7), 11, "right"),
          pad(numberText(row.unclaimedFeesSol, 7), 10, "right"),
          pad(numberText(row.pnlSol, 7), 10, "right"),
          pad(row.outOfRange ? "yes" : "no", 3),
        ].join("  "),
      );
    }
  }
  return lines.join("\n") + "\n";
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

function ratioX(numerator: unknown, denominator: unknown): number | null {
  const n = finiteMetric(numerator);
  const d = finiteMetric(denominator);
  if (n == null || d == null || d <= 0) return null;
  return n / d;
}

function inactiveLiquidityPercent(row: AnyRow): number | null {
  const active = finiteMetric(row.active_tvl);
  const total = finiteMetric(row.tvl);
  if (active == null || total == null || active < 0 || total <= 0) return null;
  // Discovery values are not necessarily sampled atomically. If active TVL is
  // greater than total TVL, do not manufacture a negative "inactive" value.
  if (active > total) return null;
  return ((total - active) / total) * 100;
}

function opportunityMetrics(row: AnyRow) {
  const inactivePct = inactiveLiquidityPercent(row);
  const volumeActive = ratioX(row.volume, row.active_tvl);
  const feeActive =
    finiteMetric(row.fee_active_tvl_ratio) ??
    (() => {
      const ratio = ratioX(row.fee, row.active_tvl);
      return ratio == null ? null : ratio * 100;
    })();
  const feeVolume = (() => {
    const ratio = ratioX(row.fee, row.volume);
    return ratio == null ? null : ratio * 100;
  })();
  const flowInactive =
    inactivePct == null || volumeActive == null
      ? null
      : volumeActive * (inactivePct / 100);
  return { inactivePct, volumeActive, feeActive, feeVolume, flowInactive };
}

const QUOTE_MINTS = new Set([
  WSOL,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
]);

function gmgnRiskNumber(row: AnyRow, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = finiteMetric(row?.[key]);
    if (value != null) return value;
  }
  return null;
}

function gmgnRiskObject(payload: unknown): AnyRow {
  if (!payload || typeof payload !== "object") return {};
  if (Array.isArray(payload))
    return (
      payload[0] && typeof payload[0] === "object" ? payload[0] : {}
    ) as AnyRow;
  const body = payload as AnyRow;
  if (body.security && typeof body.security === "object")
    return body.security as AnyRow;
  if (body.data && typeof body.data === "object" && !Array.isArray(body.data))
    return body.data as AnyRow;
  return body;
}

function gmgnHolderRows(payload: unknown): AnyRow[] {
  if (Array.isArray(payload)) return payload as AnyRow[];
  if (!payload || typeof payload !== "object") return [];
  const body = payload as AnyRow;
  if (Array.isArray(body.holders)) return body.holders;
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.list)) return body.list;
  return [];
}

function holderTags(row: AnyRow): string[] {
  const values = [
    ...(Array.isArray(row.maker_token_tags) ? row.maker_token_tags : []),
    ...(Array.isArray(row.tags) ? row.tags : []),
  ];
  return values
    .map((value: any) =>
      String(value?.name ?? value?.id ?? value ?? "").toLowerCase(),
    )
    .filter(Boolean);
}

function taggedHolderRate(holders: AnyRow[], tags: string[]): number | null {
  if (!holders.length) return null;
  let sum = 0;
  for (const holder of holders) {
    const normalized = holderTags(holder);
    if (!normalized.some((tag) => tags.some((needle) => tag.includes(needle))))
      continue;
    const pct = gmgnRate(holder, "amount_percentage", "percentage", "pct");
    if (pct != null) sum += pct;
  }
  return sum;
}

function rateValue(value: unknown): number | null {
  const n = finiteMetric(value);
  if (n == null || n < 0) return null;
  // GMGN ratios are documented as 0..1. Tolerate percentage-shaped payloads
  // without allowing impossible values to silently pass the screen.
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return null;
}

function gmgnRate(row: AnyRow, ...keys: string[]): number | null {
  for (const key of keys) {
    const n = rateValue(row?.[key]);
    if (n != null) return n;
  }
  return null;
}

function boolFalse(value: unknown): boolean {
  return (
    value === false ||
    String(value).toLowerCase() === "false" ||
    String(value).toLowerCase() === "no"
  );
}

function riskMintForRow(row: AnyRow): string | null {
  const x = String(row.token_x?.address ?? row.token_x?.mint ?? "").trim();
  const y = String(row.token_y?.address ?? row.token_y?.mint ?? "").trim();
  if (x && !QUOTE_MINTS.has(x)) return x;
  if (y && !QUOTE_MINTS.has(y)) return y;
  return x || y || null;
}

type DirectRiskThresholds = {
  maxRug: number;
  maxBundler: number;
  maxInsider: number;
  maxTop10: number;
  maxSniper: number;
  maxDev: number;
  minHolders: number;
};

type DirectRiskAssessment = {
  mint: string;
  passed: boolean;
  reasons: string[];
  metrics: AnyRow;
};

function directRiskThresholds(flags: Flags): DirectRiskThresholds {
  return {
    maxRug: Math.max(0, numberFlag(flags, "max-rug", 0.2)!),
    maxBundler: Math.max(0, numberFlag(flags, "max-bundler", 0.15)!),
    maxInsider: Math.max(0, numberFlag(flags, "max-insider", 0.15)!),
    maxTop10: Math.max(0, numberFlag(flags, "max-top10", 0.25)!),
    maxSniper: Math.max(0, numberFlag(flags, "max-sniper", 0.15)!),
    maxDev: Math.max(0, numberFlag(flags, "max-dev", 0.05)!),
    minHolders: Math.max(0, integerFlag(flags, "min-holders", 100)!),
  };
}

async function assessDirectGmgnRisk(
  slrd: Solard,
  row: AnyRow,
  thresholds: DirectRiskThresholds,
): Promise<DirectRiskAssessment> {
  const mint = riskMintForRow(row);
  if (!mint)
    return { mint: "", passed: false, reasons: ["mint_missing"], metrics: {} };

  const [securityRaw, holdersRaw] = await Promise.all([
    slrd.gmgn.tokenSecurity("sol", mint),
    slrd.gmgn.tokenTopHolders("sol", mint, { limit: 100 }),
  ]);
  const security = gmgnRiskObject(securityRaw);
  const holders = gmgnHolderRows(holdersRaw);

  const rug = gmgnRate(security, "rug_ratio");
  const bundlerCandidates = [
    gmgnRate(security, "bundler_trader_amount_rate", "bundler_rate"),
    taggedHolderRate(holders, ["bundler"]),
  ].filter((value): value is number => value != null);
  const bundler = bundlerCandidates.length
    ? Math.max(...bundlerCandidates)
    : null;
  const insiderCandidates = [
    gmgnRate(security, "suspected_insider_hold_rate"),
    gmgnRate(security, "rat_trader_amount_rate"),
    gmgnRate(security, "insider_ratio"),
    taggedHolderRate(holders, ["rat_trader", "insider"]),
  ].filter((value): value is number => value != null);
  const insider = insiderCandidates.length
    ? Math.max(...insiderCandidates)
    : null;
  const top10 = gmgnRate(security, "top_10_holder_rate", "top_holder_rate");
  const devCandidates = [
    gmgnRate(security, "dev_team_hold_rate"),
    gmgnRate(security, "creator_balance_rate"),
  ].filter((value): value is number => value != null);
  const dev = devCandidates.length ? Math.max(...devCandidates) : null;

  let sniper = gmgnRate(
    security,
    "top70_sniper_hold_rate",
    "top_70_sniper_hold_rate",
  );
  if (sniper == null) sniper = taggedHolderRate(holders, ["sniper"]);

  const holdersCount = finiteMetric(
    row.base_token_holders ?? row.token_x?.holders ?? row.token_y?.holders,
  );
  const wash =
    security.is_wash_trading === true ||
    String(security.is_wash_trading).toLowerCase() === "true";
  const reasons: string[] = [];
  const requireRate = (name: string, value: number | null, cap: number) => {
    if (value == null) reasons.push(`${name}_missing`);
    else if (value > cap) reasons.push(name);
  };
  requireRate("rug", rug, thresholds.maxRug);
  requireRate("bundler", bundler, thresholds.maxBundler);
  requireRate("insider", insider, thresholds.maxInsider);
  requireRate("top10", top10, thresholds.maxTop10);
  requireRate("sniper", sniper, thresholds.maxSniper);
  requireRate("dev", dev, thresholds.maxDev);
  if (holdersCount == null) reasons.push("holders_missing");
  else if (holdersCount < thresholds.minHolders) reasons.push("holders");
  if (wash) reasons.push("wash_trading");
  if ("renounced_mint" in security && boolFalse(security.renounced_mint))
    reasons.push("mint_authority");
  if (
    "renounced_freeze_account" in security &&
    boolFalse(security.renounced_freeze_account)
  )
    reasons.push("freeze_authority");

  return {
    mint,
    passed: reasons.length === 0,
    reasons,
    metrics: {
      rug,
      bundler,
      insider,
      top10,
      sniper,
      dev,
      holders: holdersCount,
      wash,
    },
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await fn(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function directRiskScreenRows(
  slrd: Solard,
  rows: AnyRow[],
  flags: Flags,
  outputLimit: number,
): Promise<{
  rows: AnyRow[];
  thresholds: DirectRiskThresholds;
  scanned: number;
  passed: number;
  rejects: Record<string, number>;
}> {
  if (!slrd.gmgn.configured()) {
    throw new Error(
      "--risk-screen requires GMGN_API_KEY; refusing to treat missing bundler/insider data as safe",
    );
  }
  const thresholds = directRiskThresholds(flags);
  const scanLimit = Math.max(
    outputLimit,
    Math.min(
      60,
      positiveIntegerFlag(
        flags,
        "risk-scan-limit",
        Math.max(30, outputLimit * 2),
      )!,
    ),
  );
  const candidates = rows.slice(0, scanLimit);
  const assessments = await mapWithConcurrency(candidates, 4, async (row) => {
    try {
      return await assessDirectGmgnRisk(slrd, row, thresholds);
    } catch (error) {
      return {
        mint: riskMintForRow(row) ?? "",
        passed: false,
        reasons: ["gmgn_error"],
        metrics: {
          error: error instanceof Error ? error.message : String(error),
        },
      } satisfies DirectRiskAssessment;
    }
  });
  const rejects: Record<string, number> = {};
  const passedRows: AnyRow[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const assessment = assessments[index]!;
    if (assessment.passed) {
      passedRows.push({ ...candidates[index], risk_screen: assessment });
      continue;
    }
    for (const reason of assessment.reasons)
      rejects[reason] = (rejects[reason] ?? 0) + 1;
  }
  return {
    rows: passedRows.slice(0, outputLimit),
    thresholds,
    scanned: candidates.length,
    passed: passedRows.length,
    rejects,
  };
}

function riskRejectSummary(rejects: Record<string, number>): string {
  const rows = Object.entries(rejects).sort((a, b) => b[1] - a[1]);
  return rows.length
    ? rows.map(([reason, count]) => `${reason}=${count}`).join(", ")
    : "none";
}

function multiple(value: unknown, digits = 1): string {
  const n = finiteMetric(value);
  if (n == null) return "-";
  return `${n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}x`;
}

function metricPercent(value: unknown): string {
  const n = finiteMetric(value);
  if (n == null) return "-";
  return `${n.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

function opportunitySortField(
  sort: string,
):
  | keyof ReturnType<typeof opportunityMetrics>
  | "fee"
  | "volume"
  | "active_tvl"
  | "tvl" {
  if (sort === "flow-inactive" || sort === "flow") return "flowInactive";
  if (sort === "inactive" || sort === "inactive-pct") return "inactivePct";
  if (sort === "fee-active" || sort === "fee-active-tvl") return "feeActive";
  if (sort === "volume-active" || sort === "vol-active") return "volumeActive";
  if (sort === "fee" || sort === "fees") return "fee";
  if (sort === "volume") return "volume";
  if (sort === "active-tvl") return "active_tvl";
  if (sort === "tvl" || sort === "total-tvl") return "tvl";
  throw new Error(
    "--sort must be flow-inactive, inactive, fee-active, volume-active, fee, volume, active-tvl, or tvl",
  );
}

function opportunitySortValue(
  row: AnyRow,
  field: ReturnType<typeof opportunitySortField>,
): number | null {
  if (
    field === "fee" ||
    field === "volume" ||
    field === "active_tvl" ||
    field === "tvl"
  ) {
    return finiteMetric(row[field]);
  }
  return finiteMetric(opportunityMetrics(row)[field]);
}

function sortOpportunityRows(
  rows: AnyRow[],
  sort: string,
  direction: string,
): AnyRow[] {
  const field = opportunitySortField(sort);
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = opportunitySortValue(a, field);
    const bv = opportunitySortValue(b, field);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * factor;
  });
}

function opportunityTable(rows: AnyRow[], timeframe: MeteoraTimeframe): string {
  if (!rows.length) return "No Meteora opportunities matched.\n";
  const feeLabel = `FEE ${timeframe.toUpperCase()}`;
  const volumeLabel = `VOL ${timeframe.toUpperCase()}`;
  const header = [
    pad("NAME", 20),
    pad("INACT", 8, "right"),
    pad("FLOW*INACT", 11, "right"),
    pad("VOL/ACTIVE", 10, "right"),
    pad("FEE/ACTIVE", 10, "right"),
    pad(feeLabel, 10, "right"),
    pad("ACTIVE", 10, "right"),
    pad("TOTAL", 10, "right"),
    pad(volumeLabel, 10, "right"),
    pad("BIN", 4, "right"),
    "POOL",
  ].join("  ");
  const body = rows.map((row) => {
    const m = opportunityMetrics(row);
    return [
      pad(String(row.name ?? "-"), 20),
      pad(metricPercent(m.inactivePct), 8, "right"),
      pad(multiple(m.flowInactive), 11, "right"),
      pad(multiple(m.volumeActive), 10, "right"),
      pad(percentRatio(m.feeActive), 10, "right"),
      pad(usd(row.fee), 10, "right"),
      pad(usd(row.active_tvl), 10, "right"),
      pad(usd(row.tvl), 10, "right"),
      pad(usd(row.volume), 10, "right"),
      pad(row.dlmm_params?.bin_step ?? row.bin_step ?? "-", 4, "right"),
      discoveryAddress(row),
    ].join("  ");
  });
  return [header, ...body].join("\n") + "\n";
}

function tokenMintFromRow(row: AnyRow, side: "x" | "y"): string | null {
  const token = side === "x" ? row.token_x : row.token_y;
  const mint = token?.address ?? token?.mint ?? row[`mint_${side}`] ?? null;
  return mint == null ? null : String(mint);
}

function tokenSymbolFromRow(row: AnyRow, side: "x" | "y"): string | null {
  const token = side === "x" ? row.token_x : row.token_y;
  const symbol = token?.symbol ?? row[`mint_${side}_symbol`] ?? null;
  return symbol == null ? null : String(symbol);
}

function matchesTokenQuery(row: AnyRow, query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  if (tokenMintFromRow(row, "x") === q || tokenMintFromRow(row, "y") === q)
    return true;
  const upper = q.toUpperCase();
  return (
    tokenSymbolFromRow(row, "x")?.toUpperCase() === upper ||
    tokenSymbolFromRow(row, "y")?.toUpperCase() === upper
  );
}

async function resolvePositionPool(
  slrd: Solard,
  position: string,
  flags: Flags,
): Promise<{ pool: string; walletAddress?: string }> {
  const explicit = flag(flags, "from-pool") ?? flag(flags, "pool");
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

function positiveDelta(after: bigint, before: bigint): bigint {
  return after > before ? after - before : 0n;
}

function applyHaircutRaw(amount: bigint, haircutBps: number): bigint {
  const keepBps = BigInt(Math.max(0, 10_000 - haircutBps));
  return (amount * keepBps) / 10_000n;
}

async function snapshotWalletMints(
  slrd: Solard,
  walletRef: string,
  mints: string[],
): Promise<{ byMint: Map<string, bigint>; solLamports: bigint }> {
  const wanted = new Set(mints);
  const byMint = new Map<string, bigint>();
  for (const mint of wanted) byMint.set(mint, 0n);
  const accounts = await slrd.tokenAccounts(walletRef);
  for (const account of accounts) {
    if (!wanted.has(account.mint)) continue;
    byMint.set(
      account.mint,
      (byMint.get(account.mint) ?? 0n) + BigInt(account.amountRaw),
    );
  }
  const owner = slrd.resolveWallet(walletRef).address;
  const solLamports = BigInt(
    await slrd.connection().getBalance(owner, "confirmed"),
  );
  return { byMint, solLamports };
}

function migrateRange(
  activeBin: number,
  width: number,
  amountXRaw: bigint,
  amountYRaw: bigint,
): {
  minBinId: number;
  maxBinId: number;
  inventory: "x-only" | "y-only" | "mixed";
} {
  const distance = Math.max(0, width - 1);
  if (amountXRaw > 0n && amountYRaw === 0n) {
    return {
      minBinId: activeBin,
      maxBinId: activeBin + distance,
      inventory: "x-only",
    };
  }
  if (amountYRaw > 0n && amountXRaw === 0n) {
    return {
      minBinId: activeBin - distance,
      maxBinId: activeBin,
      inventory: "y-only",
    };
  }
  const below = Math.floor(distance / 2);
  return {
    minBinId: activeBin - below,
    maxBinId: activeBin + (distance - below),
    inventory: "mixed",
  };
}

function migratePlacementValid(
  activeBin: number,
  range: {
    minBinId: number;
    maxBinId: number;
    inventory: "x-only" | "y-only" | "mixed";
  },
): boolean {
  if (range.inventory === "x-only") return range.minBinId >= activeBin;
  if (range.inventory === "y-only") return range.maxBinId <= activeBin;
  return activeBin >= range.minBinId && activeBin <= range.maxBinId;
}

function migrationHuman(result: AnyRow): string {
  const lines: string[] = [];
  const moving = result.operation === "move";
  if (!result.live) {
    lines.push(`${moving ? "Move" : "Migrate"} ${String(result.position)}`);
    if (moving) {
      lines.push(`Pool:   ${result.fromPool}`);
      lines.push(
        `Range:  ${result.sourceRange.minBinId}..${result.sourceRange.maxBinId}  ->  ${result.targetRange.minBinId}..${result.targetRange.maxBinId}`,
      );
      lines.push(
        `Active: ${result.targetActiveBin}  width=${result.sourceRange.width} bins`,
      );
    } else {
      lines.push(
        `From: ${result.fromPool}  range ${result.sourceRange.minBinId}..${result.sourceRange.maxBinId}`,
      );
      lines.push(
        `To:   ${result.toPool}  active ${result.targetActiveBin}  target ${result.targetRange.minBinId}..${result.targetRange.maxBinId}`,
      );
    }
    lines.push(
      `Inventory now: X=${result.sourceInventory.amountXRaw}  Y=${result.sourceInventory.amountYRaw}  (+ unclaimed fees on close)`,
    );
    lines.push(`Placement: ${result.targetRange.inventory}`);
    lines.push(
      moving
        ? `Dry run. Add --live to close this position and reopen only its actual close proceeds around the current bin in the same pool.`
        : `Dry run. Add --live to close the source position and reopen only its actual close proceeds in the destination pool.`,
    );
    return lines.join("\n") + "\n";
  }
  lines.push(`${moving ? "Moved" : "Migrated"} ${String(result.oldPosition)}`);
  if (moving) {
    lines.push(`Pool: ${result.fromPool}`);
  } else {
    lines.push(`From: ${result.fromPool}`);
    lines.push(`To:   ${result.toPool}`);
  }
  lines.push(`New position: ${result.newPosition}`);
  lines.push(
    `Range: ${result.range.minBinId}..${result.range.maxBinId}  active-before-send=${result.activeBinBeforeSend}`,
  );
  lines.push(
    `Moved: X=${result.moved.amountXRaw}  Y=${result.moved.amountYRaw}  haircut=${result.moved.haircutBps}bps`,
  );
  lines.push(
    `Verified: active=${result.verification.activeBin} range=${result.verification.lowerBin}..${result.verification.upperBin} inRange=${String(result.verification.inRange)}`,
  );
  lines.push(`Close tx: ${result.close.signatures.join(", ")}`);
  lines.push(`Open tx:  ${result.open.signatures.join(", ")}`);
  return lines.join("\n") + "\n";
}

async function migratePosition(
  slrd: Solard,
  position: string,
  flags: Flags,
  options: { allowSamePool?: boolean; operation?: "migrate" | "move" } = {},
): Promise<AnyRow> {
  const wallet = requiredFlag(flags, "wallet");
  const toPool = requiredFlag(flags, "to-pool");
  const operation = options.operation ?? "migrate";
  const walletAddress = publicWalletAddress(slrd, wallet);
  const explicitFromPool = flag(flags, "from-pool") ?? flag(flags, "pool");
  let fromPool: string;
  if (explicitFromPool) {
    fromPool = explicitFromPool;
  } else {
    try {
      fromPool = await slrd.meteora.findPoolForPosition(
        position,
        walletAddress,
      );
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}. Wallet-wide Meteora position enumeration can lag after rapid close/open activity; if you know the source pool, retry with --from-pool <pool-address>.`,
      );
    }
  }
  if (fromPool === toPool && !options.allowSamePool) {
    throw new Error(
      "--to-pool must differ from the source pool; use `slrd meteora move <position> --wallet <wallet>` for a same-pool range move",
    );
  }

  const [fresh, targetState] = await Promise.all([
    slrd.meteora.getPosition(fromPool, position),
    slrd.meteora.getPoolState(toPool, true),
  ]);
  if (fresh.owner && String(fresh.owner) !== walletAddress) {
    throw new Error(
      `Meteora position ${position} belongs to ${fresh.owner}, not wallet ${walletAddress}.`,
    );
  }
  const sourceX = String(fresh.tokenX?.mint ?? "");
  const sourceY = String(fresh.tokenY?.mint ?? "");
  const targetX = String(targetState.tokenX?.mint ?? "");
  const targetY = String(targetState.tokenY?.mint ?? "");
  if (!sourceX || !sourceY || !targetX || !targetY)
    throw new Error("Could not determine source/target pool token mints");
  if (
    new Set([sourceX, sourceY]).size !== 2 ||
    new Set([targetX, targetY]).size !== 2 ||
    ![sourceX, sourceY].includes(targetX) ||
    ![sourceX, sourceY].includes(targetY)
  ) {
    throw new Error(
      "Meteora migrate currently supports no-swap migration only between pools with the same two token mints",
    );
  }

  const oldMin = Number(fresh.lowerBin);
  const oldMax = Number(fresh.upperBin);
  if (!Number.isInteger(oldMin) || !Number.isInteger(oldMax))
    throw new Error("Could not determine source position bin range");
  const width = positiveIntegerFlag(flags, "bins", oldMax - oldMin + 1)!;
  const haircutBps = Math.max(
    0,
    Math.min(2_000, integerFlag(flags, "haircut-bps", 100)!),
  );

  const sourceAmounts = new Map<string, bigint>([
    [sourceX, BigInt(fresh.totalXRaw ?? "0")],
    [sourceY, BigInt(fresh.totalYRaw ?? "0")],
  ]);
  const estimatedTargetX = sourceAmounts.get(targetX) ?? 0n;
  const estimatedTargetY = sourceAmounts.get(targetY) ?? 0n;
  const targetRange = migrateRange(
    targetState.activeBin.binId,
    width,
    estimatedTargetX,
    estimatedTargetY,
  );

  if (!flags.has("live")) {
    return {
      operation,
      live: false,
      position,
      fromPool,
      toPool,
      sourceRange: { minBinId: oldMin, maxBinId: oldMax, width },
      sourceInventory: {
        amountXRaw: fresh.totalXRaw,
        amountYRaw: fresh.totalYRaw,
        feeXRaw: fresh.feeXRaw,
        feeYRaw: fresh.feeYRaw,
      },
      targetActiveBin: targetState.activeBin.binId,
      targetRange,
      targetTokens: { x: targetX, y: targetY },
      note: "Plan uses current position inventory only. Live mode measures actual close-attributable wallet deltas, including claimed fees, before opening the destination position.",
    };
  }

  const before = await snapshotWalletMints(slrd, wallet, [sourceX, sourceY]);
  const closePrepared = await slrd.meteora.buildClosePosition({
    wallet,
    pool: fromPool,
    position,
  });
  const close = await slrd.meteora.executePrepared(closePrepared, {
    live: true,
    simulate: !flags.has("skip-simulation"),
    skipPreflight: flags.has("skip-preflight"),
    commitment: (flag(flags, "commitment") as any) ?? "confirmed",
    maxRetries: integerFlag(flags, "max-retries"),
  });
  const after = await snapshotWalletMints(slrd, wallet, [sourceX, sourceY]);
  const byMint = new Map<string, bigint>();
  for (const mint of [sourceX, sourceY]) {
    byMint.set(
      mint,
      positiveDelta(
        after.byMint.get(mint) ?? 0n,
        before.byMint.get(mint) ?? 0n,
      ),
    );
  }
  const nativeSolDelta = positiveDelta(after.solLamports, before.solLamports);
  if (
    sourceX === WSOL &&
    (byMint.get(sourceX) ?? 0n) === 0n &&
    nativeSolDelta > 0n
  )
    byMint.set(sourceX, nativeSolDelta);
  if (
    sourceY === WSOL &&
    (byMint.get(sourceY) ?? 0n) === 0n &&
    nativeSolDelta > 0n
  )
    byMint.set(sourceY, nativeSolDelta);

  let amountXRaw = applyHaircutRaw(byMint.get(targetX) ?? 0n, haircutBps);
  let amountYRaw = applyHaircutRaw(byMint.get(targetY) ?? 0n, haircutBps);
  if (amountXRaw === 0n && amountYRaw === 0n) {
    throw new Error(
      `Source position closed, but no positive close-attributable proceeds were observed. Funds remain in the wallet; destination position was not opened.`,
    );
  }

  const attempts = Math.max(
    1,
    Math.min(10, positiveIntegerFlag(flags, "pre-open-retries", 3)!),
  );
  let prepared: MeteoraPreparedTransactions | null = null;
  let finalRange: ReturnType<typeof migrateRange> | null = null;
  let activeBinBeforeSend: number | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const active = await slrd.meteora.getActiveBin(toPool, true);
    const range = migrateRange(active.binId, width, amountXRaw, amountYRaw);
    prepared = await slrd.meteora.buildOpenPosition({
      wallet,
      pool: toPool,
      strategy: strategy(flags),
      amountXRaw: amountXRaw.toString(),
      amountYRaw: amountYRaw.toString(),
      minBinId: range.minBinId,
      maxBinId: range.maxBinId,
      slippageBps: integerFlag(flags, "slippage-bps", 100),
    });
    const check = await slrd.meteora.getActiveBin(toPool, true);
    activeBinBeforeSend = check.binId;
    if (migratePlacementValid(check.binId, range)) {
      finalRange = range;
      break;
    }
    prepared = null;
  }
  if (!prepared || !finalRange || activeBinBeforeSend == null) {
    throw new Error(
      `Source position was closed, but the destination active bin moved across the proposed ${width}-bin range during ${attempts} build attempts. Proceeds remain in the wallet.`,
    );
  }

  const open = await slrd.meteora.executePrepared(prepared, {
    live: true,
    simulate: !flags.has("skip-simulation"),
    skipPreflight: flags.has("skip-preflight"),
    commitment: (flag(flags, "commitment") as any) ?? "confirmed",
    maxRetries: integerFlag(flags, "max-retries"),
  });
  const verified = await slrd.meteora.getPosition(toPool, prepared.position!);
  return {
    operation,
    live: true,
    oldPosition: position,
    fromPool,
    toPool,
    close,
    newPosition: prepared.position,
    open,
    range: finalRange,
    activeBinBeforeSend,
    moved: {
      amountXRaw: amountXRaw.toString(),
      amountYRaw: amountYRaw.toString(),
      haircutBps,
    },
    verification: {
      activeBin: verified.activeBin,
      lowerBin: verified.lowerBin,
      upperBin: verified.upperBin,
      inRange: verified.inRange,
    },
  };
}

async function movePosition(
  slrd: Solard,
  position: string,
  flags: Flags,
): Promise<AnyRow> {
  const wallet = requiredFlag(flags, "wallet");
  const resolved = await resolvePositionPool(slrd, position, flags);
  const moveFlags = new Map(flags);
  moveFlags.set("wallet", wallet);
  moveFlags.set("from-pool", resolved.pool);
  moveFlags.set("to-pool", resolved.pool);
  return migratePosition(slrd, position, moveFlags, {
    allowSamePool: true,
    operation: "move",
  });
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
      // --bins N means N total bins including the active-bin boundary.
      // The lower-level binsBelow/binsAbove fields are distances from active,
      // so an N-bin one-sided range uses a distance of N - 1.
      const shorthandDistance = shorthandBins - 1;
      if (xIsSol) {
        range.binsBelow = 0;
        range.binsAbove = shorthandDistance;
      } else {
        range.binsBelow = shorthandDistance;
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

function closeAllHuman(result: AnyRow): string {
  const positions = Array.isArray(result.positions) ? result.positions : [];
  const lines = [
    `Pool: ${String(result.pool ?? "")}`,
    `Wallet: ${String(result.wallet ?? "")}`,
    `Positions: ${positions.length}`,
    "",
  ];
  if (!positions.length) {
    lines.push("No open positions in this pool.");
    return lines.join("\n") + "\n";
  }
  lines.push("POSITION\tRANGE\tINV X\tINV Y");
  for (const row of positions) {
    lines.push(
      [
        String(row.position ?? ""),
        `${String(row.lowerBin ?? "-")}..${String(row.upperBin ?? "-")}`,
        String(row.totalXRaw ?? "0"),
        String(row.totalYRaw ?? "0"),
      ].join("\t"),
    );
  }
  if (result.live === true) {
    lines.push("", `Closed: ${Number(result.closed ?? 0)}/${positions.length}`);
    const failed = Array.isArray(result.failed) ? result.failed : [];
    if (failed.length) {
      lines.push("Failures:");
      for (const row of failed)
        lines.push(
          `  ${String(row.position ?? "")}: ${String(row.error ?? "unknown error")}`,
        );
    }
  } else {
    lines.push(
      "",
      "Dry run only. Add --live to close every live position listed above.",
    );
  }
  return lines.join("\n") + "\n";
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
        `  slrd meteora opportunities [--timeframe 30m] [--sort flow-inactive|inactive|fee-active|volume-active] [--launchpad pump.fun] [--safe] [--risk-screen] [--min-inactive-pct N] [--min-volume-active N] [--limit 20]\n` +
        `  slrd meteora token-pools <mint|symbol> [--timeframe 30m] [--sort flow-inactive|fee-active|inactive] [--limit 20]\n` +
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
        `  slrd meteora close-all <pool> --wallet <wallet> [--live]\n` +
        `  slrd meteora move <position> --wallet <wallet> [--pool <pool>] [--bins N] [--haircut-bps 100] [--live]\n` +
        `  slrd meteora migrate <position> --wallet <wallet> --to-pool <pool> [--from-pool <source-pool>] [--bins N] [--haircut-bps 100] [--live]\n` +
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
    const launchpad = flag(flags, "launchpad");
    if (launchpad) baseFilters.push(`base_token_launchpad=[${launchpad}]`);
    if (flags.has("safe")) {
      baseFilters.push("base_token_has_critical_warnings=false");
      baseFilters.push("quote_token_has_critical_warnings=false");
      baseFilters.push("base_token_has_high_single_ownership=false");
    }
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

  if (action === "opportunities") {
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
    const pageSize = Math.max(
      limit,
      Math.min(100, positiveIntegerFlag(flags, "page-size", 100)!),
    );
    const direction = (flag(flags, "direction") ?? "desc").toLowerCase();
    if (direction !== "asc" && direction !== "desc")
      throw new Error("--direction must be asc or desc");
    const sort = flag(flags, "sort") ?? "flow-inactive";
    opportunitySortField(sort); // validate early

    const minTvl = numberFlag(flags, "min-tvl");
    const minActiveTvl = numberFlag(flags, "min-active-tvl");
    const minVolume = numberFlag(flags, "min-volume");
    const minFee = numberFlag(flags, "min-fee");
    const minInactivePct = numberFlag(flags, "min-inactive-pct");
    const minVolumeActive = numberFlag(flags, "min-volume-active");
    const minFeeActive = numberFlag(flags, "min-fee-active");

    const filters = ["pool_type=dlmm"];
    const launchpad = flag(flags, "launchpad");
    if (launchpad) filters.push(`base_token_launchpad=[${launchpad}]`);
    if (flags.has("safe")) {
      // Meteora metadata gate only. Bundler/insider launch structure requires
      // --risk-screen, which checks each candidate directly with GMGN token security + holder data.
      filters.push("base_token_has_critical_warnings=false");
      filters.push("quote_token_has_critical_warnings=false");
      filters.push("base_token_has_high_single_ownership=false");
    }
    const riskScreen = flags.has("risk-screen");
    if (riskScreen && !launchpad)
      filters.push("base_token_launchpad=[pump.fun]");
    appendFilter(filters, flag(flags, "filter"));
    if (minTvl != null) filters.push(`tvl>=${minTvl}`);
    if (minVolume != null) filters.push(`volume>=${minVolume}`);
    // Derived metrics are deliberately filtered locally. This keeps the CLI
    // independent of undocumented Pool Discovery filter operators.
    const feed = await slrd.meteora.discoverPools({
      pageSize,
      timeframe: tf,
      category: category as any,
      filterBy: filters.join("&&"),
    });
    let rows = [...(feed.pools as AnyRow[])].filter((row) => {
      const active = finiteMetric(row.active_tvl);
      const total = finiteMetric(row.tvl);
      const volume = finiteMetric(row.volume);
      const fee = finiteMetric(row.fee);
      const m = opportunityMetrics(row);
      if (minActiveTvl != null && (active == null || active < minActiveTvl))
        return false;
      if (minTvl != null && (total == null || total < minTvl)) return false;
      if (minVolume != null && (volume == null || volume < minVolume))
        return false;
      if (minFee != null && (fee == null || fee < minFee)) return false;
      if (
        minInactivePct != null &&
        (m.inactivePct == null || m.inactivePct < minInactivePct)
      )
        return false;
      if (
        minVolumeActive != null &&
        (m.volumeActive == null || m.volumeActive < minVolumeActive)
      )
        return false;
      if (
        minFeeActive != null &&
        (m.feeActive == null || m.feeActive < minFeeActive)
      )
        return false;
      return true;
    });
    rows = sortOpportunityRows(rows, sort, direction);
    const risk = riskScreen
      ? await directRiskScreenRows(slrd, rows, flags, limit)
      : null;
    rows = risk ? risk.rows : rows.slice(0, limit);

    const result = {
      timeframe: tf,
      category: category ?? "all",
      sort: `${sort}:${direction}`,
      formula: {
        inactivePct: "(tvl - active_tvl) / tvl * 100",
        volumeActive: "volume / active_tvl",
        flowInactive: "(volume / active_tvl) * (inactive_pct / 100)",
      },
      scope: `single Pool Discovery feed (page_size=${pageSize})`,
      filters: {
        minTvl: minTvl ?? null,
        minActiveTvl: minActiveTvl ?? null,
        minVolume: minVolume ?? null,
        minFee: minFee ?? null,
        minInactivePct: minInactivePct ?? null,
        minVolumeActive: minVolumeActive ?? null,
        minFeeActive: minFeeActive ?? null,
        meteoraMetadataSafe: flags.has("safe"),
        gmgnRiskScreen: risk
          ? {
              scanned: risk.scanned,
              passed: risk.passed,
              rejects: risk.rejects,
              ...risk.thresholds,
            }
          : null,
      },
      feedSize: feed.pools.length,
      returned: rows.length,
      pools: rows.map((row) => ({
        ...row,
        opportunity: opportunityMetrics(row),
      })),
    };
    if (flags.has("json")) {
      emit(json(result) + "\n");
    } else {
      const note = risk
        ? `Risk screen: direct GMGN token security + top holders; scanned ${risk.scanned}, passed ${risk.passed}; rejects: ${riskRejectSummary(risk.rejects)}.\n`
        : flags.has("safe")
          ? "NOTE: --safe is Meteora metadata-only. Add --risk-screen (GMGN_API_KEY required) for bundler/insider/rug screening.\n"
          : "";
      emit(note + opportunityTable(rows, tf));
    }
    return;
  }

  if (action === "token-pools") {
    const query = values[1]?.trim();
    if (!query)
      throw new Error(
        "Usage: slrd meteora token-pools <mint|symbol> [--timeframe 30m]",
      );
    const tf = timeframe(flags, "30m");
    const limit = Math.max(
      1,
      Math.min(50, positiveIntegerFlag(flags, "limit", 20)!),
    );
    const direction = (flag(flags, "direction") ?? "desc").toLowerCase();
    if (direction !== "asc" && direction !== "desc")
      throw new Error("--direction must be asc or desc");
    const sort = flag(flags, "sort") ?? "fee-active";
    opportunitySortField(sort);

    const indexed = await slrd.meteora.searchPools(query, 100);
    const indexedRows: AnyRow[] = indexed.map((pool: any) => ({
      ...(pool.raw ?? {}),
      pool_address: pool.pool,
      address: pool.pool,
      name: pool.name,
      tvl: pool.tvl,
      bin_step: pool.binStep,
      token_x: {
        ...(pool.raw?.token_x ?? {}),
        address: pool.tokenX?.mint,
        symbol: pool.tokenX?.symbol,
      },
      token_y: {
        ...(pool.raw?.token_y ?? {}),
        address: pool.tokenY?.mint,
        symbol: pool.tokenY?.symbol,
      },
    }));
    const matches = indexedRows.filter((row) => matchesTokenQuery(row, query));
    if (!matches.length) {
      throw new Error(
        `No exact Meteora token pools matched ${query}. Use a token mint for unambiguous matching.`,
      );
    }

    const enriched = await Promise.all(
      matches.slice(0, 50).map(async (row) => {
        const pool = discoveryAddress(row);
        const detail = await slrd.meteora
          .getPoolDetail(pool, tf)
          .catch(() => null);
        return detail
          ? {
              ...row,
              ...detail,
              pool_address: discoveryAddress(detail) || pool,
              name: detail.name ?? row.name,
              token_x: detail.token_x ?? row.token_x,
              token_y: detail.token_y ?? row.token_y,
              tvl: detail.tvl ?? row.tvl,
              bin_step: detail.bin_step ?? row.bin_step,
            }
          : row;
      }),
    );

    const minTvl = numberFlag(flags, "min-tvl");
    const minActiveTvl = numberFlag(flags, "min-active-tvl");
    const minVolume = numberFlag(flags, "min-volume");
    const minFee = numberFlag(flags, "min-fee");
    const minInactivePct = numberFlag(flags, "min-inactive-pct");
    const minVolumeActive = numberFlag(flags, "min-volume-active");
    const minFeeActive = numberFlag(flags, "min-fee-active");
    const filtered = enriched.filter((row) => {
      const m = opportunityMetrics(row);
      if (minTvl != null && (finiteMetric(row.tvl) ?? -Infinity) < minTvl)
        return false;
      if (
        minActiveTvl != null &&
        (finiteMetric(row.active_tvl) ?? -Infinity) < minActiveTvl
      )
        return false;
      if (
        minVolume != null &&
        (finiteMetric(row.volume) ?? -Infinity) < minVolume
      )
        return false;
      if (minFee != null && (finiteMetric(row.fee) ?? -Infinity) < minFee)
        return false;
      if (
        minInactivePct != null &&
        (m.inactivePct ?? -Infinity) < minInactivePct
      )
        return false;
      if (
        minVolumeActive != null &&
        (m.volumeActive ?? -Infinity) < minVolumeActive
      )
        return false;
      if (minFeeActive != null && (m.feeActive ?? -Infinity) < minFeeActive)
        return false;
      return true;
    });
    const rows = sortOpportunityRows(filtered, sort, direction).slice(0, limit);
    const result = {
      query,
      timeframe: tf,
      sort: `${sort}:${direction}`,
      exactMatches: matches.length,
      returned: rows.length,
      pools: rows.map((row) => ({
        ...row,
        opportunity: opportunityMetrics(row),
      })),
    };
    emit(flags.has("json") ? json(result) + "\n" : opportunityTable(rows, tf));
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
    const result = { pool, timeframe: tf, onChain, indexed, discovery };
    emit(flags.has("json") ? json(result) + "\n" : poolDetailText(result));
    return;
  }

  if (action === "candles") {
    const pool = values[1];
    if (!pool)
      throw new Error("Usage: slrd meteora candles <pool> [--timeframe 5m]");
    const result = (await slrd.meteora.getPoolOhlcv(pool, {
      timeframe: timeframe(flags, "5m"),
      startTime: numberFlag(flags, "start-time"),
      endTime: numberFlag(flags, "end-time"),
    })) as AnyRow;
    emit(flags.has("json") ? json(result) + "\n" : candlesTable(result));
    return;
  }

  if (action === "active-bin") {
    const pool = values[1];
    if (!pool) throw new Error("Usage: slrd meteora active-bin <pool>");
    const result = (await slrd.meteora.getActiveBin(pool, true)) as AnyRow;
    emit(flags.has("json") ? json(result) + "\n" : activeBinText(result));
    return;
  }

  if (action === "positions") {
    const walletRef = requiredFlag(flags, "wallet");
    const wallet = publicWalletAddress(slrd, walletRef);
    const pool = flag(flags, "pool");
    const result = pool
      ? await slrd.meteora.getPoolPositions(pool, wallet)
      : await slrd.meteora.getWalletPositions(wallet);
    emit(
      flags.has("json")
        ? json(result) + "\n"
        : positionsTable(result as AnyRow),
    );
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
    emit(
      flags.has("json") ? json(result) + "\n" : portfolioText(result as AnyRow),
    );
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

  if (
    action === "move" ||
    action === "reposition" ||
    action === "move-position"
  ) {
    const position = values[1];
    if (!position) {
      throw new Error(
        "Usage: slrd meteora move <position> --wallet <wallet> [--pool <pool>] [--bins N] [--live]",
      );
    }
    const result = await movePosition(slrd, position, flags);
    emit(flags.has("json") ? json(result) + "\n" : migrationHuman(result));
    return;
  }

  if (action === "migrate") {
    const position = values[1];
    if (!position) {
      throw new Error(
        "Usage: slrd meteora migrate <position> --wallet <wallet> --to-pool <pool> [--from-pool <source-pool>] [--bins N] [--live]",
      );
    }
    const result = await migratePosition(slrd, position, flags);
    emit(flags.has("json") ? json(result) + "\n" : migrationHuman(result));
    return;
  }

  if (action === "close-all") {
    const pool = values[1] ?? flag(flags, "pool");
    if (!pool)
      throw new Error(
        "Usage: slrd meteora close-all <pool> --wallet <wallet> [--live]",
      );
    const walletRef = requiredFlag(flags, "wallet");
    const walletAddress = publicWalletAddress(slrd, walletRef);
    const positions = await slrd.meteora.getPoolPositions(pool, walletAddress);
    const summaryPositions = positions.map((row: AnyRow) => ({
      position: String(row.position ?? ""),
      lowerBin: row.lowerBin ?? null,
      upperBin: row.upperBin ?? null,
      totalXRaw: String(row.totalXRaw ?? "0"),
      totalYRaw: String(row.totalYRaw ?? "0"),
    }));

    if (!flags.has("live")) {
      const result = {
        live: false,
        pool,
        wallet: walletAddress,
        positions: summaryPositions,
      };
      emit(flags.has("json") ? json(result) + "\n" : closeAllHuman(result));
      return;
    }

    const results: AnyRow[] = [];
    const failed: AnyRow[] = [];
    for (const row of summaryPositions) {
      if (!row.position) continue;
      try {
        const prepared = await slrd.meteora.buildClosePosition({
          wallet: walletRef,
          pool,
          position: row.position,
        });
        const executed = await finishWrite(slrd, prepared, flags);
        results.push({ position: row.position, result: executed });
      } catch (error: any) {
        failed.push({
          position: row.position,
          error: String(error?.message ?? error),
        });
        if (!flags.has("continue-on-error")) break;
      }
    }
    const result = {
      live: true,
      pool,
      wallet: walletAddress,
      positions: summaryPositions,
      closed: results.length,
      results,
      failed,
    };
    emit(flags.has("json") ? json(result) + "\n" : closeAllHuman(result));
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
