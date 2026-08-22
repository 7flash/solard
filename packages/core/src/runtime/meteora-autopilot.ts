import type { WalletRef } from "../core/refs.ts";
import type { AgentRow } from "../db/schema.ts";
import type { AgentRepo } from "../db/agent-repo.ts";
import { MeteoraDlmmService } from "../venues/meteora/dlmm.ts";
import type {
  MeteoraExecutionOptions,
  MeteoraPositionSnapshot,
  MeteoraWalletPositions,
} from "../venues/meteora/types.ts";
import {
  METEORA_AUTOPILOT_TOOL_NAMES,
  meteoraAutopilotTools,
  type MeteoraAutopilotToolName,
} from "./meteora-autopilot-tools.ts";
import type {
  MeteoraAutopilotBlacklistEntry,
  MeteoraAutopilotCandidate,
  MeteoraAutopilotConfig,
  MeteoraAutopilotCyclePlan,
  MeteoraAutopilotCycleResult,
  MeteoraAutopilotCycleReview,
  MeteoraAutopilotDecision,
  MeteoraAutopilotLesson,
  MeteoraAutopilotPlannedAction,
  MeteoraAutopilotPoolMemory,
  MeteoraAutopilotRole,
  MeteoraAutopilotState,
  MeteoraAutopilotTrackedPosition,
} from "./meteora-autopilot-types.ts";

export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

export const DEFAULT_METEORA_AUTOPILOT_CONFIG: MeteoraAutopilotConfig = {
  screening: {
    pageSize: 50,
    timeframe: "24h",
    category: "top",
    minTvl: 10_000,
    maxTvl: null,
    minVolume: 1_000,
    minFeeActiveTvlRatio: 0.01,
    minOrganic: 60,
    minQuoteOrganic: 60,
    minHolders: 100,
    minMcap: 150_000,
    maxMcap: null,
    minBinStep: 80,
    maxBinStep: 125,
    minScore: 0,
    requirePositiveVolatility: true,
    excludeCriticalWarnings: true,
    excludeHighSingleOwnership: true,
    excludeHighSupplyConcentration: true,
    quoteMint: WRAPPED_SOL_MINT,
  },
  risk: {
    maxPositions: 3,
    minDeploySol: 0.1,
    maxDeploySol: 1,
    positionSizeBps: 2500,
    gasReserveSol: 0.05,
    onePositionPerPool: true,
    onePositionPerBaseMint: true,
  },
  strategy: {
    strategy: "bid_ask",
    minTotalBins: 35,
    defaultBinsBelow: 50,
    defaultBinsAbove: 0,
    slippageBps: 300,
  },
  management: {
    minClaimUsd: 5,
    outOfRangeWaitMinutes: 30,
    stopLossPct: -15,
    takeProfitPct: 20,
    rebalanceOutOfRange: true,
    allowAutoRebalance: false,
    cooldownMinutes: 180,
    healthTimeframe: "5m",
    minHealthTvl: 5_000,
    minHealthVolume: null,
    honorAnyPositionNoteAsHold: true,
  },
  loopIntervalMs: 5 * 60_000,
};

type Dict = Record<string, unknown>;

type RunOptions = {
  execute?: boolean;
  live?: boolean;
  simulate?: boolean;
  skipPreflight?: boolean;
  limit?: number;
};

type LoopOptions = RunOptions & { intervalMs?: number };

function isObject(value: unknown): value is Dict {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const result = String(value).trim();
  return result ? result : null;
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickNumber(source: unknown, paths: string[]): number | null {
  for (const path of paths) {
    let value: unknown = source;
    for (const part of path.split(".")) {
      if (!isObject(value)) {
        value = undefined;
        break;
      }
      value = value[part];
    }
    const parsed = num(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function pickText(source: unknown, paths: string[]): string | null {
  for (const path of paths) {
    let value: unknown = source;
    for (const part of path.split(".")) {
      if (!isObject(value)) {
        value = undefined;
        break;
      }
      value = value[part];
    }
    const parsed = text(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function pickBool(source: unknown, paths: string[]): boolean | null {
  for (const path of paths) {
    let value: unknown = source;
    for (const part of path.split(".")) {
      if (!isObject(value)) {
        value = undefined;
        break;
      }
      value = value[part];
    }
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || value === "true") return true;
    if (value === 0 || value === "0" || value === "false") return false;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function assertFinite(
  name: string,
  value: number,
  min?: number,
  max?: number,
): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  if (min != null && value < min) throw new Error(`${name} must be >= ${min}`);
  if (max != null && value > max) throw new Error(`${name} must be <= ${max}`);
  return value;
}

function assertInteger(
  name: string,
  value: number,
  min?: number,
  max?: number,
): number {
  assertFinite(name, value, min, max);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function assertBoolean(name: string, value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
}

function mergeConfig(
  base: MeteoraAutopilotConfig,
  patch: unknown,
): MeteoraAutopilotConfig {
  const input = isObject(patch) ? patch : {};
  const screening = isObject(input.screening) ? input.screening : {};
  const risk = isObject(input.risk) ? input.risk : {};
  const strategy = isObject(input.strategy) ? input.strategy : {};
  const management = isObject(input.management) ? input.management : {};
  const result: MeteoraAutopilotConfig = {
    screening: {
      ...base.screening,
      ...screening,
    } as MeteoraAutopilotConfig["screening"],
    risk: { ...base.risk, ...risk } as MeteoraAutopilotConfig["risk"],
    strategy: {
      ...base.strategy,
      ...strategy,
    } as MeteoraAutopilotConfig["strategy"],
    management: {
      ...base.management,
      ...management,
    } as MeteoraAutopilotConfig["management"],
    loopIntervalMs: num(input.loopIntervalMs) ?? base.loopIntervalMs,
  };
  validateConfig(result);
  return result;
}

function validateConfig(config: MeteoraAutopilotConfig): void {
  const s = config.screening;
  assertInteger("screening.pageSize", s.pageSize, 1, 100);
  assertFinite("screening.minTvl", s.minTvl, 0);
  if (s.maxTvl != null) assertFinite("screening.maxTvl", s.maxTvl, s.minTvl);
  assertFinite("screening.minVolume", s.minVolume, 0);
  assertFinite("screening.minFeeActiveTvlRatio", s.minFeeActiveTvlRatio, 0);
  assertFinite("screening.minOrganic", s.minOrganic, 0, 100);
  assertFinite("screening.minQuoteOrganic", s.minQuoteOrganic, 0, 100);
  assertFinite("screening.minHolders", s.minHolders, 0);
  assertFinite("screening.minMcap", s.minMcap, 0);
  if (s.maxMcap != null)
    assertFinite("screening.maxMcap", s.maxMcap, s.minMcap);
  assertFinite("screening.minBinStep", s.minBinStep, 1);
  assertFinite("screening.maxBinStep", s.maxBinStep, s.minBinStep);
  assertFinite("screening.minScore", s.minScore, 0, 100);
  if (!text(s.quoteMint)) throw new Error("screening.quoteMint is required");
  if (!["5m", "30m", "1h", "2h", "4h", "12h", "24h"].includes(s.timeframe))
    throw new Error("screening.timeframe is invalid");
  if (!["top", "new", "trending"].includes(s.category))
    throw new Error("screening.category is invalid");
  assertBoolean(
    "screening.requirePositiveVolatility",
    s.requirePositiveVolatility,
  );
  assertBoolean("screening.excludeCriticalWarnings", s.excludeCriticalWarnings);
  assertBoolean(
    "screening.excludeHighSingleOwnership",
    s.excludeHighSingleOwnership,
  );
  assertBoolean(
    "screening.excludeHighSupplyConcentration",
    s.excludeHighSupplyConcentration,
  );

  const r = config.risk;
  assertInteger("risk.maxPositions", r.maxPositions, 1, 100);
  assertFinite("risk.minDeploySol", r.minDeploySol, 0);
  assertFinite("risk.maxDeploySol", r.maxDeploySol, r.minDeploySol);
  assertInteger("risk.positionSizeBps", r.positionSizeBps, 1, 10_000);
  assertFinite("risk.gasReserveSol", r.gasReserveSol, 0);
  assertBoolean("risk.onePositionPerPool", r.onePositionPerPool);
  assertBoolean("risk.onePositionPerBaseMint", r.onePositionPerBaseMint);

  const st = config.strategy;
  if (st.strategy !== "spot" && st.strategy !== "bid_ask")
    throw new Error("strategy.strategy must be spot or bid_ask for autopilot");
  assertInteger("strategy.minTotalBins", st.minTotalBins, 2);
  assertInteger("strategy.defaultBinsBelow", st.defaultBinsBelow, 0);
  assertInteger("strategy.defaultBinsAbove", st.defaultBinsAbove, 0);
  if (st.defaultBinsBelow + st.defaultBinsAbove < st.minTotalBins)
    throw new Error("strategy default range is smaller than minTotalBins");
  assertInteger("strategy.slippageBps", st.slippageBps, 0, 10_000);

  const m = config.management;
  assertFinite("management.minClaimUsd", m.minClaimUsd, 0);
  assertFinite("management.outOfRangeWaitMinutes", m.outOfRangeWaitMinutes, 0);
  if (m.stopLossPct != null)
    assertFinite("management.stopLossPct", m.stopLossPct, -100, 10_000);
  if (m.takeProfitPct != null)
    assertFinite("management.takeProfitPct", m.takeProfitPct, -100, 100_000);
  assertFinite("management.cooldownMinutes", m.cooldownMinutes, 0);
  if (m.minHealthTvl != null)
    assertFinite("management.minHealthTvl", m.minHealthTvl, 0);
  if (m.minHealthVolume != null)
    assertFinite("management.minHealthVolume", m.minHealthVolume, 0);
  if (
    !["5m", "30m", "1h", "2h", "4h", "12h", "24h"].includes(m.healthTimeframe)
  )
    throw new Error("management.healthTimeframe is invalid");
  assertBoolean("management.rebalanceOutOfRange", m.rebalanceOutOfRange);
  assertBoolean("management.allowAutoRebalance", m.allowAutoRebalance);
  assertBoolean(
    "management.honorAnyPositionNoteAsHold",
    m.honorAnyPositionNoteAsHold,
  );
  assertInteger("loopIntervalMs", config.loopIntervalMs, 5_000);
}

function rawPoolAddress(row: Dict): string | null {
  return pickText(row, [
    "pool",
    "address",
    "pool_address",
    "lb_pair",
    "lbPair",
  ]);
}

function poolBaseMint(row: Dict): string | null {
  return pickText(row, [
    "token_x.address",
    "token_x.mint",
    "base.mint",
    "base_mint",
    "base_token_address",
    "mint_x",
  ]);
}

function poolQuoteMint(row: Dict): string | null {
  return pickText(row, [
    "token_y.address",
    "token_y.mint",
    "quote.mint",
    "quote_mint",
    "quote_token_address",
    "mint_y",
  ]);
}

export function scoreMeteoraCandidate(
  input: Omit<
    MeteoraAutopilotCandidate,
    "score" | "eligible" | "rejectReasons"
  >,
  config: MeteoraAutopilotConfig,
): number {
  const tvl = Math.max(0, input.tvl ?? 0);
  if (tvl <= 0) return 0;
  const feeRatio = Math.max(0, input.feeActiveTvlRatio ?? 0);
  const volumeRatio = Math.max(0, (input.volume ?? 0) / tvl);
  const organic = clamp((input.organicScore ?? 0) / 100, 0, 1);
  const targetFeeRatio = Math.max(
    config.screening.minFeeActiveTvlRatio * 4,
    0.04,
  );
  const feeScore = clamp(feeRatio / targetFeeRatio, 0, 1);
  const volumeScore = clamp(volumeRatio / 5, 0, 1);
  const liquidityTarget = Math.max(config.screening.minTvl * 20, 200_000);
  const liquidityScore = clamp(
    Math.log10(Math.max(10, tvl)) / Math.log10(liquidityTarget),
    0,
    1,
  );
  if (
    feeScore === 0 ||
    volumeScore === 0 ||
    organic === 0 ||
    liquidityScore === 0
  )
    return 0;
  return (
    Math.round(
      (feeScore * volumeScore * organic * liquidityScore) ** 0.25 * 10_000,
    ) / 100
  );
}

function normalizeCandidate(
  row: Dict,
  config: MeteoraAutopilotConfig,
): MeteoraAutopilotCandidate {
  const base = isObject(row.token_x) ? row.token_x : {};
  const quote = isObject(row.token_y) ? row.token_y : {};
  const partial = {
    pool: rawPoolAddress(row) ?? "",
    name: pickText(row, ["name", "pool_name"]),
    baseMint: poolBaseMint(row),
    baseSymbol:
      pickText(base, ["symbol"]) ??
      pickText(row, ["base_symbol", "mint_x_symbol"]),
    quoteMint: poolQuoteMint(row),
    quoteSymbol:
      pickText(quote, ["symbol"]) ??
      pickText(row, ["quote_symbol", "mint_y_symbol"]),
    binStep: pickNumber(row, [
      "bin_step",
      "dlmm_params.bin_step",
      "pool_config.bin_step",
    ]),
    tvl: pickNumber(row, ["active_tvl", "tvl", "liquidity"]),
    volume: pickNumber(row, [
      "volume_window",
      "volume",
      "trade_volume_24h",
      "volume_24h",
    ]),
    feeActiveTvlRatio: pickNumber(row, [
      "fee_active_tvl_ratio",
      "fee_tvl_ratio",
    ]),
    volatility: pickNumber(row, [
      "volatility",
      "volatility_30m",
      "price_volatility",
    ]),
    organicScore: pickNumber(row, [
      "organic_score",
      "token_x.organic_score",
      "base.organic_score",
    ]),
    quoteOrganicScore: pickNumber(row, [
      "quote_organic_score",
      "token_y.organic_score",
      "quote.organic_score",
    ]),
    holders: pickNumber(row, [
      "holders",
      "base_token_holders",
      "token_x.holders",
    ]),
    mcap: pickNumber(row, ["mcap", "market_cap", "token_x.market_cap"]),
    activePositions: pickNumber(row, [
      "active_positions",
      "positions",
      "position_count",
    ]),
    priceChangePct: pickNumber(row, [
      "price_change_pct",
      "price_change",
      "price_change_percentage",
    ]),
    raw: row,
  } satisfies Omit<
    MeteoraAutopilotCandidate,
    "score" | "eligible" | "rejectReasons"
  >;
  return {
    ...partial,
    score: scoreMeteoraCandidate(partial, config),
    eligible: true,
    rejectReasons: [],
  };
}

function positionBaseMint(
  position: MeteoraPositionSnapshot,
  quoteMint: string,
): string | null {
  if (position.tokenY.mint === quoteMint) return position.tokenX.mint;
  if (position.tokenX.mint === quoteMint) return position.tokenY.mint;
  return null;
}

function normalizeState(input: unknown): MeteoraAutopilotState {
  const state = isObject(input) ? input : {};
  return {
    version: 1,
    decisions: Array.isArray(state.decisions)
      ? (state.decisions.slice(-250) as MeteoraAutopilotDecision[])
      : [],
    lessons: Array.isArray(state.lessons)
      ? (state.lessons.slice(-100) as MeteoraAutopilotLesson[])
      : [],
    pools: isObject(state.pools)
      ? (state.pools as Record<string, MeteoraAutopilotPoolMemory>)
      : {},
    positions: isObject(state.positions)
      ? (state.positions as Record<string, MeteoraAutopilotTrackedPosition>)
      : {},
    blacklist: isObject(state.blacklist)
      ? (state.blacklist as Record<string, MeteoraAutopilotBlacklistEntry>)
      : {},
    lastCycleAt: num(state.lastCycleAt),
    lastCycleId: text(state.lastCycleId),
    lastCycleError: text(state.lastCycleError),
  };
}

function poolMemory(
  state: MeteoraAutopilotState,
  pool: string,
  baseMint: string | null = null,
): MeteoraAutopilotPoolMemory {
  return (
    state.pools[pool] ?? {
      pool,
      baseMint,
      deployCount: 0,
      closeCount: 0,
      wins: 0,
      losses: 0,
      totalPnlUsd: 0,
      lastDeployAt: null,
      lastCloseAt: null,
      cooldownUntil: null,
      notes: [],
    }
  );
}

function extractPnl(value: unknown): {
  pnlPct: number | null;
  pnlUsd: number | null;
  feesUsd: number | null;
} {
  return {
    pnlPct: pickNumber(value, [
      "pnl_pct",
      "pnlPct",
      "pnl_percentage",
      "pnlPercentage",
      "total_pnl_pct",
      "totalPnlPct",
      "pnl.percent",
    ]),
    pnlUsd: pickNumber(value, [
      "pnl_usd",
      "pnlUsd",
      "pnl",
      "total_pnl_usd",
      "totalPnlUsd",
      "pnl.usd",
    ]),
    feesUsd: pickNumber(value, [
      "fees_usd",
      "fee_usd",
      "feesUsd",
      "feeUsd",
      "total_fee_usd",
      "totalFeesUsd",
      "fees.usd",
    ]),
  };
}

function extractHealth(value: unknown): {
  tvl: number | null;
  volume: number | null;
} {
  return {
    tvl: pickNumber(value, ["active_tvl", "tvl", "liquidity"]),
    volume: pickNumber(value, [
      "volume_window",
      "volume",
      "trade_volume_24h",
      "volume_24h",
    ]),
  };
}

export class MeteoraAutopilot {
  readonly tools = meteoraAutopilotTools;
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private cycleInFlight: Promise<MeteoraAutopilotCycleResult> | null = null;

  constructor(
    private readonly service: MeteoraDlmmService,
    readonly wallet: WalletRef,
    private readonly row: AgentRow,
    private readonly repo: AgentRepo,
  ) {}

  config(): MeteoraAutopilotConfig {
    const root = this.repo.config(this.row);
    return mergeConfig(
      DEFAULT_METEORA_AUTOPILOT_CONFIG,
      isObject(root.meteoraAutopilot) ? root.meteoraAutopilot : {},
    );
  }

  configure(patch: unknown): MeteoraAutopilotConfig {
    const next = mergeConfig(this.config(), patch);
    this.repo.mergeConfig(this.row, { meteoraAutopilot: next });
    return next;
  }

  state(): MeteoraAutopilotState {
    const root = this.repo.state(this.row);
    return normalizeState(root.meteoraAutopilot);
  }

  private saveState(state: MeteoraAutopilotState): void {
    this.repo.mergeState(this.row, { meteoraAutopilot: state });
  }

  private addDecision(
    state: MeteoraAutopilotState,
    decision: Omit<MeteoraAutopilotDecision, "id" | "at">,
  ): MeteoraAutopilotDecision {
    const value: MeteoraAutopilotDecision = {
      ...decision,
      id: id("decision"),
      at: Date.now(),
    };
    state.decisions = [...state.decisions, value].slice(-250);
    return value;
  }

  async status(): Promise<Record<string, unknown>> {
    const [balances, positions] = await Promise.all([
      this.service.getWalletNativeBalance(this.wallet),
      this.service.getMyPositions(this.wallet),
    ]);
    const state = this.state();
    return {
      wallet: balances.wallet,
      config: this.config(),
      running: this.loopTimer != null,
      solBalance: balances.sol,
      openPositions: positions.totalPositions,
      trackedPositions: Object.keys(state.positions).length,
      lessons: state.lessons.length,
      blacklistedTokens: Object.keys(state.blacklist).length,
      poolMemories: Object.keys(state.pools).length,
      lastCycleAt: state.lastCycleAt,
      lastCycleId: state.lastCycleId,
      lastCycleError: state.lastCycleError,
    };
  }

  context(
    options: { decisionLimit?: number; lessonLimit?: number } = {},
  ): Record<string, unknown> {
    const state = this.state();
    const decisionLimit = clamp(Math.trunc(options.decisionLimit ?? 12), 1, 50);
    const lessonLimit = clamp(Math.trunc(options.lessonLimit ?? 40), 1, 100);
    const lessons = [...state.lessons]
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
      )
      .slice(0, lessonLimit);
    return {
      config: this.config(),
      lessons,
      recentDecisions: state.decisions.slice(-decisionLimit).reverse(),
      positionInstructions: Object.values(state.positions)
        .filter((position) => !!position.instruction)
        .map((position) => ({
          position: position.position,
          pool: position.pool,
          instruction: position.instruction,
        })),
      blacklist: Object.values(state.blacklist),
      poolMemory: Object.values(state.pools)
        .sort(
          (a, b) =>
            (b.lastCloseAt ?? b.lastDeployAt ?? 0) -
            (a.lastCloseAt ?? a.lastDeployAt ?? 0),
        )
        .slice(0, 30),
    };
  }

  async screen(
    limit = 5,
    positionsOverride?: MeteoraWalletPositions,
  ): Promise<{
    candidates: MeteoraAutopilotCandidate[];
    rejected: MeteoraAutopilotCandidate[];
    totalDiscovered: number | null;
  }> {
    const config = this.config();
    const state = this.state();
    const positions =
      positionsOverride ?? (await this.service.getMyPositions(this.wallet));
    const occupiedPools = new Set(
      positions.positions.map((position) => position.pool),
    );
    const occupiedBaseMints = new Set(
      positions.positions
        .map((position) =>
          positionBaseMint(position, config.screening.quoteMint),
        )
        .filter((mint): mint is string => !!mint),
    );
    const discovered = await this.service.discoverPools({
      pageSize: config.screening.pageSize,
      timeframe: config.screening.timeframe,
      category: config.screening.category,
    });
    const now = Date.now();
    const all = discovered.pools.map((raw) => {
      const candidate = normalizeCandidate(raw, config);
      const reject = candidate.rejectReasons;
      const s = config.screening;
      if (!candidate.pool) reject.push("pool address missing");
      if (candidate.quoteMint !== s.quoteMint)
        reject.push(`quote mint is not configured quote ${s.quoteMint}`);
      if (candidate.mcap == null || candidate.mcap < s.minMcap)
        reject.push(`mcap below ${s.minMcap}`);
      if (
        s.maxMcap != null &&
        candidate.mcap != null &&
        candidate.mcap > s.maxMcap
      )
        reject.push(`mcap above ${s.maxMcap}`);
      if (candidate.holders == null || candidate.holders < s.minHolders)
        reject.push(`holders below ${s.minHolders}`);
      if (candidate.volume == null || candidate.volume < s.minVolume)
        reject.push(`volume below ${s.minVolume}`);
      if (candidate.tvl == null || candidate.tvl < s.minTvl)
        reject.push(`TVL below ${s.minTvl}`);
      if (s.maxTvl != null && candidate.tvl != null && candidate.tvl > s.maxTvl)
        reject.push(`TVL above ${s.maxTvl}`);
      if (
        candidate.feeActiveTvlRatio == null ||
        candidate.feeActiveTvlRatio < s.minFeeActiveTvlRatio
      )
        reject.push(`fee/active-TVL below ${s.minFeeActiveTvlRatio}`);
      if (
        candidate.binStep == null ||
        candidate.binStep < s.minBinStep ||
        candidate.binStep > s.maxBinStep
      )
        reject.push(`bin step outside ${s.minBinStep}-${s.maxBinStep}`);
      if (
        candidate.organicScore == null ||
        candidate.organicScore < s.minOrganic
      )
        reject.push(`base organic score below ${s.minOrganic}`);
      if (
        candidate.quoteOrganicScore == null ||
        candidate.quoteOrganicScore < s.minQuoteOrganic
      )
        reject.push(`quote organic score below ${s.minQuoteOrganic}`);
      if (
        s.requirePositiveVolatility &&
        !(candidate.volatility != null && candidate.volatility > 0)
      )
        reject.push("volatility is missing or non-positive");
      if (
        s.excludeCriticalWarnings &&
        (pickBool(raw, ["base_token_has_critical_warnings"]) === true ||
          pickBool(raw, ["quote_token_has_critical_warnings"]) === true)
      )
        reject.push("critical token warning");
      if (
        s.excludeHighSingleOwnership &&
        pickBool(raw, ["base_token_has_high_single_ownership"]) === true
      )
        reject.push("high single ownership");
      if (
        s.excludeHighSupplyConcentration &&
        pickBool(raw, ["base_token_has_high_supply_concentration"]) === true
      )
        reject.push("high supply concentration");
      if (candidate.score < s.minScore)
        reject.push(`score below ${s.minScore}`);
      if (candidate.baseMint && state.blacklist[candidate.baseMint])
        reject.push("base token blacklisted");
      const memory = candidate.pool ? state.pools[candidate.pool] : undefined;
      if (memory?.cooldownUntil && memory.cooldownUntil > now)
        reject.push("pool cooldown active");
      if (config.risk.onePositionPerPool && occupiedPools.has(candidate.pool))
        reject.push("already have an open position in this pool");
      if (
        config.risk.onePositionPerBaseMint &&
        candidate.baseMint &&
        occupiedBaseMints.has(candidate.baseMint)
      )
        reject.push("already exposed to this base mint");
      candidate.eligible = reject.length === 0;
      return candidate;
    });
    const candidates = all
      .filter((candidate) => candidate.eligible)
      .sort((a, b) => b.score - a.score)
      .slice(0, clamp(Math.trunc(limit), 1, 50));
    const rejected = all.filter((candidate) => !candidate.eligible);
    return { candidates, rejected, totalDiscovered: discovered.total };
  }

  private syncTrackedPositions(
    state: MeteoraAutopilotState,
    positions: MeteoraPositionSnapshot[],
    quoteMint: string,
  ): void {
    const now = Date.now();
    const open = new Set<string>();
    for (const position of positions) {
      open.add(position.position);
      const existing = state.positions[position.position] ?? {
        position: position.position,
        pool: position.pool,
        baseMint: positionBaseMint(position, quoteMint),
        openedAt: null,
        outOfRangeSince: null,
        instruction: null,
      };
      existing.pool = position.pool;
      existing.baseMint =
        existing.baseMint ?? positionBaseMint(position, quoteMint);
      if (position.inRange === false) existing.outOfRangeSince ??= now;
      if (position.inRange === true) existing.outOfRangeSince = null;
      state.positions[position.position] = existing;
    }
    for (const position of Object.keys(state.positions)) {
      if (!open.has(position)) delete state.positions[position];
    }
  }

  async managementPlan(
    positionsOverride?: MeteoraWalletPositions,
  ): Promise<MeteoraAutopilotPlannedAction[]> {
    const config = this.config();
    const state = this.state();
    const walletPositions =
      positionsOverride ?? (await this.service.getMyPositions(this.wallet));
    this.syncTrackedPositions(
      state,
      walletPositions.positions,
      config.screening.quoteMint,
    );
    const now = Date.now();
    const actions: MeteoraAutopilotPlannedAction[] = [];

    for (const position of walletPositions.positions) {
      const tracked = state.positions[position.position]!;
      const [pnlRaw, healthRaw] = await Promise.all([
        this.service
          .getPositionPnl({
            pool: position.pool,
            wallet: walletPositions.wallet,
            position: position.position,
            status: "open",
          })
          .catch(() => null),
        this.service
          .getPoolDetail(position.pool, config.management.healthTimeframe)
          .catch(() => null),
      ]);
      const pnl = extractPnl(pnlRaw);
      const health = extractHealth(healthRaw);
      const minutesOut =
        tracked.outOfRangeSince == null
          ? 0
          : Math.max(0, Math.floor((now - tracked.outOfRangeSince) / 60_000));
      const metrics = {
        inRange: position.inRange,
        minutesOutOfRange: minutesOut,
        pnlPct: pnl.pnlPct,
        pnlUsd: pnl.pnlUsd,
        feesUsd: pnl.feesUsd,
        tvl: health.tvl,
        volume: health.volume,
      };

      let wanted: MeteoraAutopilotPlannedAction | null = null;
      if (
        config.management.stopLossPct != null &&
        pnl.pnlPct != null &&
        pnl.pnlPct <= config.management.stopLossPct
      ) {
        wanted = {
          kind: "close",
          pool: position.pool,
          position: position.position,
          reason: `stop loss: PnL ${pnl.pnlPct.toFixed(2)}% <= ${config.management.stopLossPct}%`,
          priority: 100,
          metrics,
          note: tracked.instruction,
        };
      } else if (
        config.management.takeProfitPct != null &&
        pnl.pnlPct != null &&
        pnl.pnlPct >= config.management.takeProfitPct
      ) {
        wanted = {
          kind: "close",
          pool: position.pool,
          position: position.position,
          reason: `take profit: PnL ${pnl.pnlPct.toFixed(2)}% >= ${config.management.takeProfitPct}%`,
          priority: 95,
          metrics,
          note: tracked.instruction,
        };
      } else if (
        config.management.minHealthTvl != null &&
        health.tvl != null &&
        health.tvl < config.management.minHealthTvl
      ) {
        wanted = {
          kind: "close",
          pool: position.pool,
          position: position.position,
          reason: `pool TVL ${health.tvl} below health floor ${config.management.minHealthTvl}`,
          priority: 90,
          metrics,
          note: tracked.instruction,
        };
      } else if (
        config.management.minHealthVolume != null &&
        health.volume != null &&
        health.volume < config.management.minHealthVolume
      ) {
        wanted = {
          kind: "close",
          pool: position.pool,
          position: position.position,
          reason: `pool volume ${health.volume} below health floor ${config.management.minHealthVolume}`,
          priority: 85,
          metrics,
          note: tracked.instruction,
        };
      } else if (
        position.inRange === false &&
        minutesOut >= config.management.outOfRangeWaitMinutes
      ) {
        const wantsRebalance = config.management.rebalanceOutOfRange;
        const canAutoRebalance =
          wantsRebalance && config.management.allowAutoRebalance;
        wanted = {
          kind:
            wantsRebalance && !canAutoRebalance
              ? "review"
              : canAutoRebalance
                ? "rebalance"
                : "close",
          pool: position.pool,
          position: position.position,
          reason:
            wantsRebalance && !canAutoRebalance
              ? `out of range for ${minutesOut}m; automatic rebalance is disabled`
              : `out of range for ${minutesOut}m`,
          priority: 80,
          metrics,
          note: tracked.instruction,
        };
      } else if (
        pnl.feesUsd != null &&
        pnl.feesUsd >= config.management.minClaimUsd
      ) {
        wanted = {
          kind: "claim",
          pool: position.pool,
          position: position.position,
          reason: `unclaimed fees $${pnl.feesUsd.toFixed(2)} >= $${config.management.minClaimUsd}`,
          priority: 40,
          metrics,
          note: tracked.instruction,
        };
      }

      if (
        wanted &&
        tracked.instruction &&
        config.management.honorAnyPositionNoteAsHold &&
        wanted.kind !== "claim" &&
        wanted.kind !== "review"
      ) {
        actions.push({
          ...wanted,
          kind: "review",
          reason: `${wanted.reason}; position has persistent instruction`,
          priority: wanted.priority + 1,
        });
      } else if (wanted) {
        actions.push(wanted);
      }
    }

    this.saveState(state);
    return actions.sort((a, b) => b.priority - a.priority);
  }

  private deployAmount(
    solBalance: number,
    config: MeteoraAutopilotConfig,
  ): number | null {
    const free = Math.max(0, solBalance - config.risk.gasReserveSol);
    const amount = Math.min(
      config.risk.maxDeploySol,
      free * (config.risk.positionSizeBps / 10_000),
    );
    if (amount < config.risk.minDeploySol) return null;
    return Math.floor(amount * 1_000_000_000) / 1_000_000_000;
  }

  async planCycle(limit = 5): Promise<MeteoraAutopilotCyclePlan> {
    const cycleId = id("cycle");
    const config = this.config();
    const [balance, positions] = await Promise.all([
      this.service.getWalletNativeBalance(this.wallet),
      this.service.getMyPositions(this.wallet),
    ]);
    const [management, screened] = await Promise.all([
      this.managementPlan(positions),
      this.screen(limit, positions),
    ]);
    const plannedExits = management.filter(
      (action) => action.kind === "close" || action.kind === "rebalance",
    ).length;
    const effectivePositions = Math.max(
      0,
      positions.totalPositions - plannedExits,
    );
    const amountSol = this.deployAmount(balance.sol, config);
    let deployment: MeteoraAutopilotPlannedAction | null = null;
    const candidate = screened.candidates[0];
    if (
      candidate &&
      amountSol != null &&
      effectivePositions < config.risk.maxPositions
    ) {
      deployment = {
        kind: "deploy",
        pool: candidate.pool,
        reason: `top eligible pool score ${candidate.score.toFixed(2)}`,
        priority: 20,
        candidate,
        metrics: {
          amountSol,
          score: candidate.score,
          binsBelow: config.strategy.defaultBinsBelow,
          binsAbove: config.strategy.defaultBinsAbove,
        },
      };
    }
    return {
      cycleId,
      at: Date.now(),
      wallet: balance.wallet,
      solBalance: balance.sol,
      freeSol: Math.max(0, balance.sol - config.risk.gasReserveSol),
      openPositions: positions.totalPositions,
      management,
      deployment,
      candidates: screened.candidates,
    };
  }

  private executionOptions(options: RunOptions): MeteoraExecutionOptions {
    if (options.execute && !options.live)
      throw new Error(
        "Autopilot execution requires both execute=true and live=true",
      );
    return {
      live: options.live === true,
      simulate: options.simulate ?? true,
      skipPreflight: options.skipPreflight ?? false,
    };
  }

  private recordPoolDeploy(
    state: MeteoraAutopilotState,
    pool: string,
    baseMint: string | null,
    position: string | undefined,
  ): void {
    const memory = poolMemory(state, pool, baseMint);
    memory.baseMint ??= baseMint;
    memory.deployCount += 1;
    memory.lastDeployAt = Date.now();
    memory.cooldownUntil = null;
    state.pools[pool] = memory;
    if (position) {
      state.positions[position] = {
        position,
        pool,
        baseMint,
        openedAt: Date.now(),
        outOfRangeSince: null,
        instruction: state.positions[position]?.instruction ?? null,
      };
    }
  }

  private recordPoolClose(
    state: MeteoraAutopilotState,
    action: MeteoraAutopilotPlannedAction,
    cooldown: boolean,
  ): void {
    const pnlUsd =
      typeof action.metrics?.pnlUsd === "number" ? action.metrics.pnlUsd : null;
    const memory = poolMemory(state, action.pool, null);
    memory.closeCount += 1;
    memory.lastCloseAt = Date.now();
    if (pnlUsd != null) {
      memory.totalPnlUsd += pnlUsd;
      if (pnlUsd >= 0) memory.wins += 1;
      else memory.losses += 1;
    }
    if (cooldown) {
      memory.cooldownUntil =
        Date.now() + this.config().management.cooldownMinutes * 60_000;
    }
    state.pools[action.pool] = memory;
    if (action.position) delete state.positions[action.position];
  }

  private async executeRebalance(
    action: MeteoraAutopilotPlannedAction,
    options: MeteoraExecutionOptions,
  ): Promise<{ signatures: string[]; position?: string }> {
    const config = this.config();
    if (!config.management.allowAutoRebalance)
      throw new Error(
        "Automatic rebalance is disabled; set management.allowAutoRebalance=true to enable it",
      );
    if (!action.position) throw new Error("Rebalance action requires position");
    const position = await this.service.getPosition(
      action.pool,
      action.position,
    );
    if (position.tokenY.mint !== config.screening.quoteMint)
      throw new Error(
        "Automatic rebalance currently requires the configured quote mint to be token Y",
      );
    const baseMint = position.tokenX.mint;
    const before = await this.service.getWalletTokenBalance(
      this.wallet,
      baseMint,
    );
    const closed = await this.service.executePrepared(
      await this.service.buildClosePosition({
        wallet: this.wallet,
        pool: action.pool,
        position: action.position,
      }),
      options,
    );
    const after = await this.service.getWalletTokenBalance(
      this.wallet,
      baseMint,
    );
    const delta = BigInt(after.rawAmount) - BigInt(before.rawAmount);
    const signatures = [...closed.signatures];
    if (delta > 0n) {
      const swapped = await this.service.executePrepared(
        await this.service.buildSwapExactIn({
          wallet: this.wallet,
          pool: action.pool,
          swapForY: true,
          amountInRaw: delta.toString(),
          slippageBps: config.strategy.slippageBps,
          allowPartialFill: false,
        }),
        options,
      );
      signatures.push(...swapped.signatures);
    }
    const balance = await this.service.getWalletNativeBalance(this.wallet);
    const amountSol = this.deployAmount(balance.sol, config);
    if (amountSol == null)
      throw new Error(
        "Rebalance closed/swapped successfully but free SOL is below the minimum redeploy amount",
      );
    const opened = await this.service.executePrepared(
      await this.service.buildOpenPosition({
        wallet: this.wallet,
        pool: action.pool,
        strategy: config.strategy.strategy,
        amountY: amountSol,
        amountX: 0,
        binsBelow: config.strategy.defaultBinsBelow,
        binsAbove: config.strategy.defaultBinsAbove,
        slippageBps: config.strategy.slippageBps,
      }),
      options,
    );
    signatures.push(...opened.signatures);
    return { signatures, position: opened.position };
  }

  private async executeAction(
    action: MeteoraAutopilotPlannedAction,
    options: MeteoraExecutionOptions,
  ): Promise<{ signatures: string[]; position?: string }> {
    const config = this.config();
    if (action.kind === "review") return { signatures: [] };
    if (action.kind === "claim") {
      if (!action.position) throw new Error("Claim action requires position");
      const result = await this.service.executePrepared(
        await this.service.buildClaimFees({
          wallet: this.wallet,
          pool: action.pool,
          position: action.position,
        }),
        options,
      );
      return { signatures: result.signatures, position: result.position };
    }
    if (action.kind === "close") {
      if (!action.position) throw new Error("Close action requires position");
      const result = await this.service.executePrepared(
        await this.service.buildClosePosition({
          wallet: this.wallet,
          pool: action.pool,
          position: action.position,
        }),
        options,
      );
      return { signatures: result.signatures, position: result.position };
    }
    if (action.kind === "rebalance")
      return await this.executeRebalance(action, options);
    if (action.kind === "deploy") {
      const candidate = action.candidate;
      if (!candidate) throw new Error("Deploy action requires candidate");
      if (candidate.quoteMint !== config.screening.quoteMint)
        throw new Error(
          "Autopilot deploy candidate quote mint changed or is unsupported",
        );
      const amountSol =
        typeof action.metrics?.amountSol === "number"
          ? action.metrics.amountSol
          : null;
      if (amountSol == null)
        throw new Error("Deploy action is missing amountSol");

      // Re-check portfolio and cash immediately before broadcasting. A prior close/rebalance
      // may have failed after the plan was built; never let a stale plan bypass risk limits.
      const [currentPositions, currentBalance] = await Promise.all([
        this.service.getMyPositions(this.wallet),
        this.service.getWalletNativeBalance(this.wallet),
      ]);
      if (currentPositions.totalPositions >= config.risk.maxPositions)
        throw new Error(
          `Max positions (${config.risk.maxPositions}) reached before deploy`,
        );
      if (
        config.risk.onePositionPerPool &&
        currentPositions.positions.some(
          (position) => position.pool === candidate.pool,
        )
      )
        throw new Error(
          `Already have an open position in pool ${candidate.pool}`,
        );
      if (config.risk.onePositionPerBaseMint && candidate.baseMint) {
        const duplicateBase = currentPositions.positions.some(
          (position) =>
            positionBaseMint(position, config.screening.quoteMint) ===
            candidate.baseMint,
        );
        if (duplicateBase)
          throw new Error(`Already exposed to base mint ${candidate.baseMint}`);
      }
      if (currentBalance.sol < amountSol + config.risk.gasReserveSol)
        throw new Error(
          `Insufficient SOL before deploy: have ${currentBalance.sol}, need ${amountSol + config.risk.gasReserveSol}`,
        );
      const latestState = this.state();
      if (candidate.baseMint && latestState.blacklist[candidate.baseMint])
        throw new Error(
          `Base mint ${candidate.baseMint} was blacklisted after planning`,
        );
      const latestMemory = latestState.pools[candidate.pool];
      if (
        latestMemory?.cooldownUntil &&
        latestMemory.cooldownUntil > Date.now()
      )
        throw new Error(
          `Pool ${candidate.pool} entered cooldown after planning`,
        );

      const requestedStrategy = action.metrics?.strategy;
      const strategy =
        requestedStrategy === "spot" || requestedStrategy === "bid_ask"
          ? requestedStrategy
          : config.strategy.strategy;
      const requestedBinsBelow =
        typeof action.metrics?.binsBelow === "number"
          ? Math.trunc(action.metrics.binsBelow)
          : config.strategy.defaultBinsBelow;
      const requestedBinsAbove =
        typeof action.metrics?.binsAbove === "number"
          ? Math.trunc(action.metrics.binsAbove)
          : config.strategy.defaultBinsAbove;
      if (requestedBinsBelow < 0 || requestedBinsAbove < 0)
        throw new Error("Meteora deployment bin counts must be non-negative");
      if (
        requestedBinsBelow + requestedBinsAbove <
        config.strategy.minTotalBins
      )
        throw new Error(
          `Meteora deployment range must cover at least ${config.strategy.minTotalBins} bins`,
        );
      // Autopilot deployments are single-sided quote-token (SOL/WSOL) deposits.
      // Do not let a model request upside bins that cannot be funded by amountX=0.
      if (requestedBinsAbove !== 0)
        throw new Error(
          "Single-sided autopilot deployment requires binsAbove=0",
        );

      const result = await this.service.executePrepared(
        await this.service.buildOpenPosition({
          wallet: this.wallet,
          pool: candidate.pool,
          strategy,
          amountX: 0,
          amountY: amountSol,
          binsBelow: requestedBinsBelow,
          binsAbove: requestedBinsAbove,
          slippageBps: config.strategy.slippageBps,
        }),
        options,
      );
      return { signatures: result.signatures, position: result.position };
    }
    throw new Error(`Unsupported autopilot action: ${action.kind}`);
  }

  async runReviewedPlan(
    plan: MeteoraAutopilotCyclePlan,
    review: MeteoraAutopilotCycleReview,
    options: RunOptions = {},
  ): Promise<MeteoraAutopilotCycleResult> {
    if (this.cycleInFlight)
      throw new Error("A Meteora autopilot cycle is already running");
    this.cycleInFlight = this.runReviewedPlanInternal(plan, review, options);
    try {
      return await this.cycleInFlight;
    } finally {
      this.cycleInFlight = null;
    }
  }

  private async runReviewedPlanInternal(
    plan: MeteoraAutopilotCyclePlan,
    review: MeteoraAutopilotCycleReview,
    options: RunOptions,
  ): Promise<MeteoraAutopilotCycleResult> {
    const execute = options.execute === true;
    const live = options.live === true;
    const execution = this.executionOptions(options);
    const state = this.state();
    state.lastCycleAt = Date.now();
    state.lastCycleId = plan.cycleId;
    state.lastCycleError = null;

    const approvals = new Map(
      review.management.map((entry) => [entry.position, entry]),
    );
    const reviewedManagement = plan.management.map((action) => {
      const approval = action.position
        ? approvals.get(action.position)
        : undefined;
      return {
        action,
        approved: approval?.approve === true,
        reason: approval?.reason ?? "not approved by intelligence reviewer",
      };
    });

    let reviewedDeployment: MeteoraAutopilotPlannedAction | null = null;
    if (review.deployment.approve) {
      const pool = text(review.deployment.pool);
      if (!pool) throw new Error("Approved deployment requires a pool address");
      const candidate = plan.candidates.find((item) => item.pool === pool);
      if (!candidate || !candidate.eligible)
        throw new Error(
          `Reviewed deployment pool ${pool} is not an eligible candidate`,
        );
      const config = this.config();
      const amountSol = this.deployAmount(plan.solBalance, config);
      if (amountSol == null)
        throw new Error(
          "Reviewed deployment has no deployable SOL after reserve/risk limits",
        );
      const strategy = review.deployment.strategy ?? config.strategy.strategy;
      if (strategy !== "spot" && strategy !== "bid_ask")
        throw new Error("Reviewed deployment strategy must be spot or bid_ask");
      const binsBelow = Math.trunc(
        review.deployment.binsBelow ?? config.strategy.defaultBinsBelow,
      );
      const binsAbove = Math.trunc(
        review.deployment.binsAbove ?? config.strategy.defaultBinsAbove,
      );
      if (binsBelow < 0 || binsAbove < 0)
        throw new Error("Reviewed deployment bin counts must be non-negative");
      if (binsBelow + binsAbove < config.strategy.minTotalBins)
        throw new Error(
          `Reviewed deployment range must cover at least ${config.strategy.minTotalBins} bins`,
        );
      if (binsAbove !== 0)
        throw new Error(
          "Single-sided reviewed deployment requires binsAbove=0",
        );
      reviewedDeployment = {
        kind: "deploy",
        pool: candidate.pool,
        candidate,
        priority: 20,
        reason:
          text(review.deployment.reason) ??
          `intelligence approved ${candidate.pool}`,
        metrics: {
          amountSol,
          score: candidate.score,
          strategy,
          binsBelow,
          binsAbove,
        },
      };
    }

    const results: MeteoraAutopilotCycleResult["results"] = [];
    try {
      this.addDecision(state, {
        cycleId: plan.cycleId,
        actor: "AUTOPILOT",
        type: "screen",
        summary: "intelligence-reviewed cycle",
        reason: reviewedDeployment
          ? `deployment approved for ${reviewedDeployment.pool}`
          : "deployment skipped by intelligence reviewer",
        executed: false,
      });

      for (const reviewed of reviewedManagement) {
        const action = reviewed.action;
        if (!reviewed.approved || action.kind === "review") {
          results.push({ action, success: true, signatures: [] });
          this.addDecision(state, {
            cycleId: plan.cycleId,
            actor: "MANAGER",
            type: "skip",
            pool: action.pool,
            position: action.position,
            summary: `reviewed ${action.kind} skipped`,
            reason: action.kind === "review" ? action.reason : reviewed.reason,
            executed: false,
            metrics: action.metrics,
          });
          continue;
        }
        if (!execute) {
          results.push({ action, success: true, signatures: [] });
          this.addDecision(state, {
            cycleId: plan.cycleId,
            actor: "MANAGER",
            type: action.kind,
            pool: action.pool,
            position: action.position,
            summary: `reviewed ${action.kind} planned`,
            reason: reviewed.reason || action.reason,
            executed: false,
            metrics: action.metrics,
          });
          continue;
        }
        try {
          const result = await this.executeAction(action, execution);
          results.push({
            action,
            success: true,
            signatures: result.signatures,
          });
          if (action.kind === "close")
            this.recordPoolClose(state, action, true);
          if (action.kind === "rebalance") {
            const baseMint = action.position
              ? (state.positions[action.position]?.baseMint ?? null)
              : null;
            this.recordPoolClose(state, action, false);
            this.recordPoolDeploy(
              state,
              action.pool,
              baseMint,
              result.position,
            );
          }
          this.addDecision(state, {
            cycleId: plan.cycleId,
            actor: "MANAGER",
            type: action.kind,
            pool: action.pool,
            position: action.position ?? result.position,
            summary: `executed reviewed ${action.kind}`,
            reason: reviewed.reason || action.reason,
            executed: true,
            signatures: result.signatures,
            metrics: action.metrics,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          results.push({
            action,
            success: false,
            signatures: [],
            error: message,
          });
          this.addDecision(state, {
            cycleId: plan.cycleId,
            actor: "AUTOPILOT",
            type: "error",
            pool: action.pool,
            position: action.position,
            summary: `reviewed ${action.kind} failed`,
            reason: message,
            executed: false,
            metrics: action.metrics,
          });
        }
      }

      if (reviewedDeployment) {
        const action = reviewedDeployment;
        if (!execute) {
          results.push({ action, success: true, signatures: [] });
          this.addDecision(state, {
            cycleId: plan.cycleId,
            actor: "SCREENER",
            type: "deploy",
            pool: action.pool,
            summary: "reviewed deploy planned",
            reason: action.reason,
            executed: false,
            metrics: action.metrics,
          });
        } else {
          try {
            const result = await this.executeAction(action, execution);
            results.push({
              action,
              success: true,
              signatures: result.signatures,
            });
            this.recordPoolDeploy(
              state,
              action.pool,
              action.candidate?.baseMint ?? null,
              result.position,
            );
            this.addDecision(state, {
              cycleId: plan.cycleId,
              actor: "SCREENER",
              type: "deploy",
              pool: action.pool,
              position: result.position,
              summary: "executed reviewed deploy",
              reason: action.reason,
              executed: true,
              signatures: result.signatures,
              metrics: action.metrics,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            results.push({
              action,
              success: false,
              signatures: [],
              error: message,
            });
            this.addDecision(state, {
              cycleId: plan.cycleId,
              actor: "AUTOPILOT",
              type: "error",
              pool: action.pool,
              summary: "reviewed deploy failed",
              reason: message,
              executed: false,
              metrics: action.metrics,
            });
          }
        }
      }

      this.saveState(state);
      return {
        ...plan,
        deployment: reviewedDeployment,
        executed: execute,
        live,
        results,
      };
    } catch (error) {
      state.lastCycleError =
        error instanceof Error ? error.message : String(error);
      this.saveState(state);
      throw error;
    }
  }

  async runCycle(
    options: RunOptions = {},
  ): Promise<MeteoraAutopilotCycleResult> {
    if (this.cycleInFlight) return await this.cycleInFlight;
    this.cycleInFlight = this.runCycleInternal(options);
    try {
      return await this.cycleInFlight;
    } finally {
      this.cycleInFlight = null;
    }
  }

  private async runCycleInternal(
    options: RunOptions,
  ): Promise<MeteoraAutopilotCycleResult> {
    const execute = options.execute === true;
    const live = options.live === true;
    const execution = this.executionOptions(options);
    let state = this.state();
    try {
      const plan = await this.planCycle(options.limit ?? 5);
      state = this.state();
      state.lastCycleAt = Date.now();
      state.lastCycleId = plan.cycleId;
      state.lastCycleError = null;
      this.addDecision(state, {
        cycleId: plan.cycleId,
        actor: "SCREENER",
        type: "screen",
        summary: `${plan.candidates.length} eligible candidate(s)`,
        reason: plan.candidates[0]
          ? `top score ${plan.candidates[0].score.toFixed(2)} on ${plan.candidates[0].pool}`
          : "no eligible deployment candidate",
        executed: false,
      });

      const actions = [
        ...plan.management,
        ...(plan.deployment ? [plan.deployment] : []),
      ];
      const results: MeteoraAutopilotCycleResult["results"] = [];
      for (const action of actions) {
        if (!execute || action.kind === "review") {
          results.push({ action, success: true, signatures: [] });
          this.addDecision(state, {
            cycleId: plan.cycleId,
            actor: action.kind === "deploy" ? "SCREENER" : "MANAGER",
            type: action.kind === "review" ? "skip" : action.kind,
            pool: action.pool,
            position: action.position,
            summary: `${execute ? "review" : "planned"} ${action.kind}`,
            reason: action.reason,
            executed: false,
            metrics: action.metrics,
          });
          continue;
        }
        try {
          const result = await this.executeAction(action, execution);
          results.push({
            action,
            success: true,
            signatures: result.signatures,
          });
          if (action.kind === "deploy")
            this.recordPoolDeploy(
              state,
              action.pool,
              action.candidate?.baseMint ?? null,
              result.position,
            );
          if (action.kind === "close")
            this.recordPoolClose(state, action, true);
          if (action.kind === "rebalance") {
            const baseMint = action.position
              ? (state.positions[action.position]?.baseMint ?? null)
              : null;
            this.recordPoolClose(state, action, false);
            this.recordPoolDeploy(
              state,
              action.pool,
              baseMint,
              result.position,
            );
          }
          this.addDecision(state, {
            cycleId: plan.cycleId,
            actor: action.kind === "deploy" ? "SCREENER" : "MANAGER",
            type: action.kind,
            pool: action.pool,
            position: action.position ?? result.position,
            summary: `executed ${action.kind}`,
            reason: action.reason,
            executed: true,
            signatures: result.signatures,
            metrics: action.metrics,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          results.push({
            action,
            success: false,
            signatures: [],
            error: message,
          });
          this.addDecision(state, {
            cycleId: plan.cycleId,
            actor: "AUTOPILOT",
            type: "error",
            pool: action.pool,
            position: action.position,
            summary: `${action.kind} failed`,
            reason: message,
            executed: false,
            metrics: action.metrics,
          });
        }
      }
      this.saveState(state);
      return { ...plan, executed: execute, live, results };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lastCycleAt = Date.now();
      state.lastCycleError = message;
      this.addDecision(state, {
        cycleId: null,
        actor: "AUTOPILOT",
        type: "error",
        summary: "cycle failed",
        reason: message,
        executed: false,
      });
      this.saveState(state);
      throw error;
    }
  }

  startLoop(options: LoopOptions = {}): {
    running: true;
    intervalMs: number;
    execute: boolean;
    live: boolean;
  } {
    if (this.loopTimer)
      throw new Error("Meteora autopilot loop is already running");
    const intervalMs = Math.max(
      5_000,
      Math.trunc(options.intervalMs ?? this.config().loopIntervalMs),
    );
    const run = () => {
      void this.runCycle(options).catch(() => undefined);
    };
    run();
    this.loopTimer = setInterval(run, intervalMs);
    return {
      running: true,
      intervalMs,
      execute: options.execute === true,
      live: options.live === true,
    };
  }

  stopLoop(): { running: false } {
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = null;
    return { running: false };
  }

  async call(
    toolName: MeteoraAutopilotToolName | string,
    input: unknown = {},
  ): Promise<unknown> {
    if (!METEORA_AUTOPILOT_TOOL_NAMES.has(toolName))
      throw new Error(`Unknown Meteora autopilot tool: ${toolName}`);
    const args = isObject(input) ? input : {};
    switch (toolName) {
      case "meteora_autopilot_status":
        return await this.status();
      case "meteora_autopilot_configure":
        return this.configure(args);
      case "meteora_autopilot_context":
        return this.context({
          decisionLimit: num(args.decision_limit) ?? undefined,
          lessonLimit: num(args.lesson_limit) ?? undefined,
        });
      case "meteora_autopilot_screen":
        return await this.screen(num(args.limit) ?? 5);
      case "meteora_autopilot_management_plan":
        return await this.managementPlan();
      case "meteora_autopilot_plan_cycle":
        return await this.planCycle(num(args.limit) ?? 5);
      case "meteora_autopilot_run_cycle":
        return await this.runCycle({
          limit: num(args.limit) ?? undefined,
          execute: args.execute === true,
          live: args.live === true,
          simulate:
            typeof args.simulate === "boolean" ? args.simulate : undefined,
          skipPreflight:
            typeof args.skip_preflight === "boolean"
              ? args.skip_preflight
              : undefined,
        });
      case "meteora_autopilot_history":
        return this.history(num(args.limit) ?? 25);
      case "meteora_autopilot_list_lessons":
        return this.listLessons(
          text(args.role) as MeteoraAutopilotRole | undefined,
        );
      case "meteora_autopilot_add_lesson":
        return this.addLesson({
          rule: text(args.rule) ?? "",
          tags: Array.isArray(args.tags)
            ? args.tags.map((tag) => String(tag))
            : undefined,
          role: text(args.role) as MeteoraAutopilotRole | null,
          pinned: args.pinned === true,
        });
      case "meteora_autopilot_pin_lesson":
        return this.pinLesson(
          text(args.lesson_id) ?? "",
          args.pinned !== false,
        );
      case "meteora_autopilot_remove_lesson":
        return { removed: this.removeLesson(text(args.lesson_id) ?? "") };
      case "meteora_autopilot_get_pool_memory":
        return this.getPoolMemory(text(args.pool_address) ?? "");
      case "meteora_autopilot_add_pool_note":
        return this.addPoolNote(
          text(args.pool_address) ?? "",
          text(args.note) ?? "",
        );
      case "meteora_autopilot_set_position_note":
        return this.setPositionNote(
          text(args.position_address) ?? "",
          args.instruction == null ? null : text(args.instruction),
        );
      case "meteora_autopilot_blacklist_token":
        return this.blacklistToken({
          mint: text(args.mint) ?? "",
          symbol: text(args.symbol),
          reason: text(args.reason) ?? "",
        });
      case "meteora_autopilot_unblacklist_token":
        return { removed: this.unblacklistToken(text(args.mint) ?? "") };
      case "meteora_autopilot_list_blacklist":
        return this.listBlacklist();
      default:
        throw new Error(`Unknown Meteora autopilot tool: ${toolName}`);
    }
  }

  history(limit = 25): MeteoraAutopilotDecision[] {
    return this.state()
      .decisions.slice(-clamp(Math.trunc(limit), 1, 250))
      .reverse();
  }

  listLessons(role?: MeteoraAutopilotRole): MeteoraAutopilotLesson[] {
    return this.state()
      .lessons.filter(
        (lesson) => !role || lesson.role == null || lesson.role === role,
      )
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
      );
  }

  addLesson(input: {
    rule: string;
    tags?: string[];
    role?: MeteoraAutopilotRole | null;
    pinned?: boolean;
  }): MeteoraAutopilotLesson {
    const rule = text(input.rule);
    if (!rule) throw new Error("lesson rule is required");
    const state = this.state();
    const now = Date.now();
    const lesson: MeteoraAutopilotLesson = {
      id: id("lesson"),
      rule,
      tags: Array.isArray(input.tags)
        ? [
            ...new Set(
              input.tags.map((tag) => String(tag).trim()).filter(Boolean),
            ),
          ].slice(0, 20)
        : [],
      role: input.role ?? null,
      pinned: input.pinned === true,
      createdAt: now,
      updatedAt: now,
    };
    state.lessons = [...state.lessons, lesson].slice(-100);
    this.saveState(state);
    return lesson;
  }

  pinLesson(lessonId: string, pinned = true): MeteoraAutopilotLesson {
    const state = this.state();
    const lesson = state.lessons.find((item) => item.id === lessonId);
    if (!lesson) throw new Error(`Unknown lesson ${lessonId}`);
    lesson.pinned = pinned;
    lesson.updatedAt = Date.now();
    this.saveState(state);
    return lesson;
  }

  removeLesson(lessonId: string): boolean {
    const state = this.state();
    const before = state.lessons.length;
    state.lessons = state.lessons.filter((item) => item.id !== lessonId);
    this.saveState(state);
    return state.lessons.length !== before;
  }

  getPoolMemory(pool: string): MeteoraAutopilotPoolMemory {
    return poolMemory(this.state(), pool);
  }

  addPoolNote(pool: string, noteInput: string): MeteoraAutopilotPoolMemory {
    const note = text(noteInput);
    if (!note) throw new Error("pool note is required");
    const state = this.state();
    const memory = poolMemory(state, pool);
    memory.notes = [
      ...memory.notes,
      { id: id("note"), note, at: Date.now() },
    ].slice(-50);
    state.pools[pool] = memory;
    this.saveState(state);
    return memory;
  }

  setPositionNote(
    position: string,
    instructionInput: string | null,
  ): MeteoraAutopilotTrackedPosition {
    const state = this.state();
    const existing = state.positions[position];
    if (!existing)
      throw new Error(`Position ${position} is not currently tracked`);
    existing.instruction = text(instructionInput);
    state.positions[position] = existing;
    this.saveState(state);
    return existing;
  }

  blacklistToken(input: {
    mint: string;
    reason: string;
    symbol?: string | null;
  }): MeteoraAutopilotBlacklistEntry {
    const mint = text(input.mint);
    const reason = text(input.reason);
    if (!mint) throw new Error("blacklist mint is required");
    if (!reason) throw new Error("blacklist reason is required");
    const state = this.state();
    const entry: MeteoraAutopilotBlacklistEntry = {
      mint,
      symbol: text(input.symbol),
      reason,
      at: Date.now(),
    };
    state.blacklist[mint] = entry;
    this.saveState(state);
    return entry;
  }

  unblacklistToken(mintInput: string): boolean {
    const mint = text(mintInput);
    if (!mint) throw new Error("blacklist mint is required");
    const state = this.state();
    const existed = !!state.blacklist[mint];
    delete state.blacklist[mint];
    this.saveState(state);
    return existed;
  }

  listBlacklist(): MeteoraAutopilotBlacklistEntry[] {
    return Object.values(this.state().blacklist).sort((a, b) => b.at - a.at);
  }
}
