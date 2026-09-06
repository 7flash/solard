import type {
  MeteoraPoolCategory,
  MeteoraStrategy,
  MeteoraTimeframe,
} from "../venues/meteora/types.ts";

export type MeteoraAutopilotRole = "SCREENER" | "MANAGER" | "GENERAL";

export type MeteoraAutopilotScreeningConfig = {
  pageSize: number;
  timeframe: MeteoraTimeframe;
  category: MeteoraPoolCategory;
  minTvl: number;
  maxTvl: number | null;
  minVolume: number;
  minFeeActiveTvlRatio: number;
  minOrganic: number;
  minQuoteOrganic: number;
  minHolders: number;
  minMcap: number;
  maxMcap: number | null;
  minBinStep: number;
  maxBinStep: number;
  minScore: number;
  requirePositiveVolatility: boolean;
  excludeCriticalWarnings: boolean;
  excludeHighSingleOwnership: boolean;
  excludeHighSupplyConcentration: boolean;
  quoteMint: string;
};

export type MeteoraAutopilotRiskConfig = {
  maxPositions: number;
  minDeploySol: number;
  maxDeploySol: number;
  positionSizeBps: number;
  gasReserveSol: number;
  onePositionPerPool: boolean;
  onePositionPerBaseMint: boolean;
};

export type MeteoraAutopilotStrategyConfig = {
  strategy: Exclude<MeteoraStrategy, "curve">;
  /** Fixed range is the legacy behavior. previous-5m-candle retargets open LPs to the last fully closed 5m candle. */
  rangePolicy: "fixed" | "previous-5m-candle";
  minTotalBins: number;
  defaultBinsBelow: number;
  defaultBinsAbove: number;
  candlePaddingBins: number;
  /** Ignore tiny candle-to-candle target changes to avoid needless close/reopen churn. */
  minRangeShiftBins: number;
  /** Skip a candle rebalance when the active bin has broken too far beyond the previous candle. */
  maxBreakoutBins: number;
  slippageBps: number;
};

export type MeteoraAutopilotManagementConfig = {
  minClaimUsd: number;
  outOfRangeWaitMinutes: number;
  stopLossPct: number | null;
  takeProfitPct: number | null;
  rebalanceOutOfRange: boolean;
  allowAutoRebalance: boolean;
  cooldownMinutes: number;
  healthTimeframe: MeteoraTimeframe;
  minHealthTvl: number | null;
  minHealthVolume: number | null;
  honorAnyPositionNoteAsHold: boolean;
};

export type MeteoraAutopilotConfig = {
  screening: MeteoraAutopilotScreeningConfig;
  risk: MeteoraAutopilotRiskConfig;
  strategy: MeteoraAutopilotStrategyConfig;
  management: MeteoraAutopilotManagementConfig;
  loopIntervalMs: number;
};

export type MeteoraAutopilotCandidate = {
  pool: string;
  name: string | null;
  baseMint: string | null;
  baseSymbol: string | null;
  quoteMint: string | null;
  quoteSymbol: string | null;
  binStep: number | null;
  tvl: number | null;
  volume: number | null;
  feeActiveTvlRatio: number | null;
  volatility: number | null;
  organicScore: number | null;
  quoteOrganicScore: number | null;
  holders: number | null;
  mcap: number | null;
  activePositions: number | null;
  priceChangePct: number | null;
  score: number;
  eligible: boolean;
  rejectReasons: string[];
  raw: Record<string, unknown>;
};

export type MeteoraAutopilotActionKind =
  "claim" | "close" | "rebalance" | "deploy" | "review";

export type MeteoraAutopilotPlannedAction = {
  kind: MeteoraAutopilotActionKind;
  pool: string;
  position?: string;
  reason: string;
  priority: number;
  candidate?: MeteoraAutopilotCandidate;
  metrics?: Record<string, number | string | boolean | null>;
  note?: string | null;
};

export type MeteoraAutopilotDecision = {
  id: string;
  at: number;
  cycleId: string | null;
  actor: "SCREENER" | "MANAGER" | "AUTOPILOT";
  type:
    "screen" | "deploy" | "claim" | "close" | "rebalance" | "skip" | "error";
  pool?: string;
  position?: string;
  summary: string;
  reason: string;
  executed: boolean;
  signatures?: string[];
  metrics?: Record<string, number | string | boolean | null>;
};

export type MeteoraAutopilotLesson = {
  id: string;
  rule: string;
  tags: string[];
  role: MeteoraAutopilotRole | null;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
};

export type MeteoraAutopilotPoolMemory = {
  pool: string;
  baseMint: string | null;
  deployCount: number;
  closeCount: number;
  wins: number;
  losses: number;
  totalPnlUsd: number;
  lastDeployAt: number | null;
  lastCloseAt: number | null;
  cooldownUntil: number | null;
  notes: { id: string; note: string; at: number }[];
};

export type MeteoraAutopilotTrackedPosition = {
  position: string;
  pool: string;
  baseMint: string | null;
  openedAt: number | null;
  outOfRangeSince: number | null;
  instruction: string | null;
};

export type MeteoraAutopilotBlacklistEntry = {
  mint: string;
  symbol: string | null;
  reason: string;
  at: number;
};

export type MeteoraAutopilotState = {
  version: 1;
  decisions: MeteoraAutopilotDecision[];
  lessons: MeteoraAutopilotLesson[];
  pools: Record<string, MeteoraAutopilotPoolMemory>;
  positions: Record<string, MeteoraAutopilotTrackedPosition>;
  blacklist: Record<string, MeteoraAutopilotBlacklistEntry>;
  lastCycleAt: number | null;
  lastCycleId: string | null;
  lastCycleError: string | null;
};

export type MeteoraAutopilotCyclePlan = {
  cycleId: string;
  at: number;
  wallet: string;
  solBalance: number;
  freeSol: number;
  openPositions: number;
  management: MeteoraAutopilotPlannedAction[];
  deployment: MeteoraAutopilotPlannedAction | null;
  candidates: MeteoraAutopilotCandidate[];
};

export type MeteoraAutopilotCycleResult = MeteoraAutopilotCyclePlan & {
  executed: boolean;
  live: boolean;
  results: Array<{
    action: MeteoraAutopilotPlannedAction;
    success: boolean;
    signatures: string[];
    error?: string;
  }>;
};

export type MeteoraAutopilotCycleReview = {
  management: Array<{
    position: string;
    approve: boolean;
    reason?: string;
  }>;
  deployment: {
    approve: boolean;
    pool: string | null;
    reason?: string;
    strategy?: "spot" | "bid_ask";
    binsBelow?: number;
    binsAbove?: number;
  };
};
