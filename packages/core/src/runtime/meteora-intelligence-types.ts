import type {
  MeteoraAutopilotCandidate,
  MeteoraAutopilotCyclePlan,
  MeteoraAutopilotPlannedAction,
} from "./meteora-autopilot-types.ts";
import type {
  MeteoraStrategy,
  MeteoraTimeframe,
} from "../venues/meteora/types.ts";

export type MeteoraIndicatorPreset =
  | "supertrend_break"
  | "rsi_reversal"
  | "bollinger_reversion"
  | "rsi_plus_supertrend"
  | "supertrend_or_rsi"
  | "bb_plus_rsi"
  | "fibo_reclaim"
  | "fibo_reject";

export type MeteoraSmartWalletType = "lp" | "holder";
export type MeteoraSmartWalletCategory = "alpha" | "smart" | "fast" | "multi";

export type MeteoraSmartWallet = {
  address: string;
  name: string;
  category: MeteoraSmartWalletCategory;
  type: MeteoraSmartWalletType;
  addedAt: number;
  note: string | null;
};

export type MeteoraStrategyDefinition = {
  id: string;
  name: string;
  author: string | null;
  lpStrategy: Exclude<MeteoraStrategy, "curve">;
  tokenCriteria: {
    minMcap?: number;
    maxMcap?: number;
    minHolders?: number;
    minOrganic?: number;
    maxTop10HolderPct?: number;
    requiresSmartWallet?: boolean;
    requireNarrative?: boolean;
    notes?: string;
  };
  entry: {
    indicatorPreset?: MeteoraIndicatorPreset;
    requireIndicator?: boolean;
    notes?: string;
  };
  range: {
    binsBelow?: number;
    binsAbove?: number;
    downsidePct?: number;
    upsidePct?: number;
    notes?: string;
  };
  exit: {
    stopLossPct?: number;
    takeProfitPct?: number;
    notes?: string;
  };
  bestFor: string | null;
  raw: string | null;
  createdAt: number;
  updatedAt: number;
};

export type MeteoraTokenAudit = {
  mintDisabled: boolean | null;
  freezeDisabled: boolean | null;
  topHoldersPct: number | null;
  botHoldersPct: number | null;
  devMigrations: number | null;
};

export type MeteoraTokenInfo = {
  mint: string;
  name: string | null;
  symbol: string | null;
  mcap: number | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  organicScore: number | null;
  organicLabel: string | null;
  launchpad: string | null;
  graduated: boolean | null;
  globalFeesSol: number | null;
  audit: MeteoraTokenAudit | null;
  stats1h: Record<string, number | null> | null;
  raw: Record<string, unknown>;
};

export type MeteoraHolder = {
  address: string;
  amount: string | number | null;
  pct: number | null;
  solBalance: number | null;
  tags: string[];
  isPool: boolean;
  funding: {
    address: string;
    amount: number | null;
    slot: number | null;
  } | null;
};

export type MeteoraSmartWalletExposure = {
  wallet: MeteoraSmartWallet;
  holderPct: number | null;
  tokenPnl: Record<string, unknown> | null;
  lpPositions: number;
};

export type MeteoraHolderReport = {
  mint: string;
  totalFetched: number;
  showing: number;
  top10RealHoldersPct: number;
  holders: MeteoraHolder[];
  smartWalletsHolding: MeteoraSmartWalletExposure[];
  globalFeesSol: number | null;
};

export type MeteoraNarrative = {
  mint: string;
  narrative: string | null;
  status: string | null;
};

export type MeteoraIndicatorSignal = {
  close: number | null;
  previousClose: number | null;
  rsi: number | null;
  lowerBand: number | null;
  middleBand: number | null;
  upperBand: number | null;
  supertrendValue: number | null;
  supertrendDirection: "bullish" | "bearish" | "unknown";
  supertrendBreakUp: boolean;
  supertrendBreakDown: boolean;
  fib50: number | null;
  fib618: number | null;
  fib786: number | null;
};

export type MeteoraIndicatorConfirmation = {
  enabled: boolean;
  confirmed: boolean;
  skipped: boolean;
  preset: MeteoraIndicatorPreset | null;
  side: "entry" | "exit";
  requireAllIntervals: boolean;
  reason: string;
  intervals: Array<{
    timeframe: MeteoraTimeframe;
    ok: boolean;
    confirmed: boolean | null;
    reason: string;
    signal: MeteoraIndicatorSignal | null;
  }>;
};

export type MeteoraTopLperStudy = {
  available: boolean;
  pool: string;
  source: string;
  patterns: Record<string, unknown>;
  lpers: Record<string, unknown>[];
  error?: string;
  raw?: unknown;
};

export type MeteoraIntelligenceConfig = {
  token: {
    enabled: boolean;
    dataApiBase: string;
    timeoutMs: number;
    requireMintDisabled: boolean;
    requireFreezeDisabled: boolean;
    maxTop10HolderPct: number | null;
    maxBotHolderPct: number | null;
    minGlobalFeesSol: number | null;
  };
  indicators: {
    enabled: boolean;
    entryPreset: MeteoraIndicatorPreset;
    exitPreset: MeteoraIndicatorPreset;
    timeframes: MeteoraTimeframe[];
    requireAllIntervals: boolean;
    rsiLength: number;
    rsiOversold: number;
    rsiOverbought: number;
    bollingerLength: number;
    bollingerStdDev: number;
    supertrendAtrLength: number;
    supertrendMultiplier: number;
    candleCount: number;
  };
  topLpers: {
    enabled: boolean;
    baseUrl: string;
    publicApiKey: string | null;
    timeoutMs: number;
    limit: number;
  };
  smartWallets: {
    enabled: boolean;
    scoreBonus: number;
  };
  model: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string | null;
    model: string | null;
    timeoutMs: number;
    temperature: number;
  };
  decision: {
    candidateLimit: number;
    enrichConcurrency: number;
    requireTokenInfo: boolean;
    requireHolderReport: boolean;
    requireIndicatorConfirmation: boolean;
    requireNarrative: boolean;
    allowModelCandidateSelection: boolean;
  };
};

export type MeteoraIntelligenceState = {
  version: 1;
  smartWallets: Record<string, MeteoraSmartWallet>;
  strategies: Record<string, MeteoraStrategyDefinition>;
  activeStrategyId: string | null;
  decisions: MeteoraIntelligenceDecisionRecord[];
};

export type MeteoraCandidateIntelligence = {
  candidate: MeteoraAutopilotCandidate;
  tokenInfo: MeteoraTokenInfo | null;
  holders: MeteoraHolderReport | null;
  narrative: MeteoraNarrative | null;
  indicator: MeteoraIndicatorConfirmation | null;
  smartWallets: MeteoraSmartWalletExposure[];
  topLpers: MeteoraTopLperStudy | null;
  strategy: MeteoraStrategyDefinition | null;
  intelligenceScore: number;
  eligible: boolean;
  rejectReasons: string[];
  warnings: string[];
};

export type MeteoraModelManagementDecision = {
  position: string;
  approve: boolean;
  reason: string;
};

export type MeteoraModelDeploymentDecision = {
  approve: boolean;
  pool: string | null;
  reason: string;
  strategyId: string | null;
  binsBelow: number | null;
  binsAbove: number | null;
};

export type MeteoraModelCycleDecision = {
  deployment: MeteoraModelDeploymentDecision;
  management: MeteoraModelManagementDecision[];
  lessons: Array<{
    rule: string;
    tags: string[];
    role: "SCREENER" | "MANAGER" | "GENERAL" | null;
    pinned: boolean;
  }>;
  summary: string;
};

export type MeteoraIntelligenceDecisionInput = {
  generatedAt: number;
  wallet: string;
  autopilotContext: Record<string, unknown>;
  cyclePlan: MeteoraAutopilotCyclePlan;
  candidates: MeteoraCandidateIntelligence[];
  strategies: MeteoraStrategyDefinition[];
  activeStrategy: MeteoraStrategyDefinition | null;
  smartWallets: MeteoraSmartWallet[];
  constraints: {
    managementActionsMayOnlyBeApprovedOrSkipped: true;
    deploymentMustUseEligibleCandidate: true;
    liveExecutionStillRequiresAutopilotGates: true;
  };
};

export type MeteoraIntelligenceDecisionRecord = {
  id: string;
  at: number;
  model: string | null;
  summary: string;
  deploymentPool: string | null;
  approvedManagement: string[];
  rejectedManagement: string[];
  executed: boolean;
  signatures: string[];
};

export type MeteoraReviewedAutopilotInput = {
  plan: MeteoraAutopilotCyclePlan;
  management: Array<{
    action: MeteoraAutopilotPlannedAction;
    approved: boolean;
    reason?: string;
  }>;
  deployment: {
    candidate: MeteoraAutopilotCandidate | null;
    approved: boolean;
    reason?: string;
    strategy?: Exclude<MeteoraStrategy, "curve">;
    binsBelow?: number;
    binsAbove?: number;
  };
};
