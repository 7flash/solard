import type {
  Commitment,
  Keypair,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { WalletRef } from "../../core/refs.ts";

export type MeteoraStrategy = "spot" | "bid_ask" | "curve";
export type MeteoraTimeframe =
  "5m" | "30m" | "1h" | "2h" | "4h" | "12h" | "24h";
export type MeteoraPoolCategory = "top" | "new" | "trending";
export type MeteoraTransaction = Transaction | VersionedTransaction;
export type MeteoraInteger = bigint | number | string;
export type MeteoraUiAmount = number | string;

export const METEORA_MARKET_FEATURE_SCHEMA_V1 =
  "meteora-market-features-v1" as const;
export const METEORA_MARKET_FEATURE_SEMANTICS_HASH_V1 =
  "sha256:df0cb334157a903fe0632e9e25dc06c6a00e045f1cee0c93d090d95330183c1d" as const;
export const METEORA_POOL_DISCOVERY_SCHEMA_V1 =
  "meteora-pool-discovery-v1" as const;

export type MeteoraErrorCode =
  | "INFRASTRUCTURE_FUNDING_REQUIRED"
  | "MISSING_REQUIRED_SIGNER"
  | "LIVE_TRADING_DISABLED"
  | "SIMULATION_FAILED"
  | "TRANSACTION_FAILED"
  | "PARTIAL_EXECUTION"
  | "VERIFICATION_FAILED"
  | "MOVE_FAILED"
  | "SNAPSHOT_INCONSISTENT"
  | "POSITION_NOT_FOUND"
  | "POOL_MISMATCH"
  | "OWNER_MISMATCH"
  | "RANGE_MISMATCH"
  | "INSUFFICIENT_FUNDS"
  | "INVALID_ARGUMENT"
  | "SDK_INCOMPATIBLE"
  | "DATA_API_ERROR"
  | "LIMIT_ORDER_UNSUPPORTED"
  | "LIMIT_ORDER_NOT_FOUND"
  | "UNKNOWN";

export type MeteoraRange = {
  minBinId: number;
  maxBinId: number;
};

export type MeteoraPairSide = "x" | "y";

export type MeteoraPairDescriptor = {
  version: 1;
  pool: string;
  tokenX: MeteoraPoolToken;
  tokenY: MeteoraPoolToken;
  quoteMint: string;
  baseMint: string;
  quoteSide: MeteoraPairSide;
  baseSide: MeteoraPairSide;
  /**
   * +1 means increasing bin id increases base-token price in quote units.
   * -1 means increasing bin id decreases base-token price in quote units.
   */
  basePriceBinDirection: 1 | -1;
};

export type MeteoraWalletPoolBalances = {
  version: 1;
  observedAt: number;
  wallet: string;
  pool: string;
  nativeLamports: string;
  tokenX: MeteoraPoolToken;
  tokenY: MeteoraPoolToken;
  tokenXRaw: string;
  tokenYRaw: string;
  tokenXAccountCount: number;
  tokenYAccountCount: number;
};

export type MeteoraOpenBatchCandidate = {
  id: string;
  strategy?: MeteoraStrategy;
  minBinId: number;
  maxBinId: number;
  amountXRaw?: MeteoraInteger;
  amountYRaw?: MeteoraInteger;
  infrastructure?: MeteoraInfrastructureFundingPolicy;
};

export type MeteoraOpenBatchPreflightArgs = {
  wallet: WalletRef;
  pool: string;
  candidates: MeteoraOpenBatchCandidate[];
  /** Applied when a candidate does not provide its own infrastructure policy. */
  infrastructure?: MeteoraInfrastructureFundingPolicy;
  /** Native SOL to leave untouched after position-account/infrastructure costs. */
  nativeReserveLamports?: MeteoraInteger;
  commitment?: Commitment;
};

export type MeteoraOpenBatchPreflightCandidate = {
  id: string;
  strategy: MeteoraStrategy;
  minBinId: number;
  maxBinId: number;
  width: number;
  positionKind: "standard" | "extended";
  executable: boolean;
  errorCode: MeteoraErrorCode | null;
  errorMessage: string | null;
  infrastructure: MeteoraInfrastructureQuote | null;
  transactionCount: number | null;
  positionCostLamports: string | null;
  positionReallocCostLamports: string | null;
  refundablePositionLamportsUpperBound: string | null;
  nonRefundableInfrastructureLamportsUpperBound: string;
  requiresSharedInfrastructure: boolean;
  sharedInfrastructureAuthorized: boolean;
  safeWithoutSharedInfrastructureFunding: boolean;
  requestedAmountXRaw: string;
  requestedAmountYRaw: string;
};

export type MeteoraOpenBatchPreflight = {
  version: 1;
  observedAt: number;
  wallet: string;
  pool: string;
  /** All candidates passed range/SDK/infrastructure policy checks. */
  safeToBuild: boolean;
  /** All requested principal can be sourced from the wallet under Solard's current SOL-wrapping behavior. */
  principalFundingSufficient: boolean;
  /**
   * Full preflight except transaction network/priority fees, which are not known
   * without constructing the transactions. Keep nativeReserveLamports large enough
   * to absorb those fees.
   */
  safeToExecuteBeforeNetworkFee: boolean;
  /** @deprecated Alias of safeToExecuteBeforeNetworkFee. */
  safeToExecute: boolean;
  availableNativeLamports: string;
  balances: MeteoraWalletPoolBalances;
  nativeReserveLamports: string;
  candidates: MeteoraOpenBatchPreflightCandidate[];
  total: {
    executableCandidates: number;
    rejectedCandidates: number;
    refundablePositionLamportsUpperBound: string | null;
    nonRefundableInfrastructureLamportsUpperBound: string;
    estimatedNetworkFeeLamports: null;
    requiredNativeLamportsBeforeNetworkFeeUpperBound: string | null;
    requestedPrincipalXRaw: string;
    requestedPrincipalYRaw: string;
    /**
     * Requested WSOL-side principal. Solard currently uses Meteora's default SOL
     * wrapping path for position opens, so this is conservatively treated as native SOL.
     */
    requestedWsolPrincipalLamports: string;
    /** Recoverable rent + authorized shared infrastructure + reserve + WSOL principal. */
    requiredNativeLamportsIncludingWsolPrincipalBeforeNetworkFeeUpperBound:
      string | null;
    tokenXPrincipalSufficient: boolean;
    tokenYPrincipalSufficient: boolean;
    nativeFundingSufficientBeforeNetworkFee: boolean | null;
  };
};

export type MeteoraPoolWalletSnapshotArgs = {
  pool: string;
  wallet: WalletRef;
  /** When present, return only these exact position addresses. */
  positionIds?: string[];
  includeMarketMetrics?: boolean;
  marketMetrics?: MeteoraOhlcvArgs & {
    depthRadius?: number;
    oracleTwapWindowsSec?: number[];
    includeOracleObservations?: boolean;
  };
  commitment?: Commitment;
  consistency?: {
    /** Allowed active-bin movement across the snapshot read. Default 0. */
    maxActiveBinDrift?: number;
    /** Number of whole-snapshot attempts. Default 3. */
    attempts?: number;
    /** Delay between inconsistent attempts. Default 150ms. */
    retryDelayMs?: number;
  };
  /** Fail when any requested position id is absent. Default false. */
  requireAllPositions?: boolean;
};

export type MeteoraPoolWalletSnapshot = {
  version: 1;
  observedAt: number;
  wallet: string;
  pool: string;
  activeBin: number;
  priceYPerX: number;
  slotBefore: number | null;
  slotAfter: number | null;
  balances: MeteoraWalletPoolBalances;
  positions: MeteoraPositionSnapshot[];
  positionsById: Record<string, MeteoraPositionSnapshot>;
  requestedPositionIds: string[];
  missingPositionIds: string[];
  marketMetrics: MeteoraPoolMarketMetrics | null;
  consistency: {
    attempts: number;
    activeBinBefore: number;
    activeBinAfter: number;
    activeBinDrift: number;
    maxActiveBinDrift: number;
    stable: boolean;
  };
};

export type MeteoraMarketFeatureVectorV1 = {
  schema: typeof METEORA_MARKET_FEATURE_SCHEMA_V1;
  semanticsVersion: 1;
  /**
   * SHA-256 identity of the canonical field/unit/source semantics manifest.
   * Persist this with every learning row and never mix populations whose hash differs.
   */
  semanticsHash: typeof METEORA_MARKET_FEATURE_SEMANTICS_HASH_V1;
  /** @deprecated Use semanticsHash. Retained for compatibility with the earlier patch. */
  semanticsId: "meteora-market-features-v1-20260825";
  observedAtMs: number;
  pool: string;
  slot: number | null;
  activeBin: number;
  priceYPerX: number;
  activeTvlUsd: number | null;
  feeActiveTvlPct: number | null;
  volumeActiveTvlPct: number | null;
  dynamicFeePct: number | null;
  candleRangeP90Bins: number | null;
  candleCloseMoveP90Bins: number | null;
  pathBinsPerMinute: number | null;
  netBinsPerMinute: number | null;
  trendEfficiency: number | null;
  directionFlips: number | null;
  stationaryTimePct: number | null;
  realizedVolPct: number | null;
  moveP90Bins: number | null;
  dwellP90Sec: number | null;
  spotVsTwap60Bins: number | null;
  spotVsTwap300Bins: number | null;
  oracleAgeSec: number | null;
  emptyBinPct: number | null;
  sideImbalancePct: number | null;
  concentrationPct: number | null;
  quality: {
    candleCount: number;
    microSampleCount: number;
    oracleSupported: boolean;
    oracleAvailable: boolean;
    oracleTwap60Covered: boolean | null;
    oracleTwap300Covered: boolean | null;
    nonNullFeatureCount: number;
  };
};

export type MeteoraMarketFeatureVectorArgs = MeteoraOhlcvArgs & {
  depthRadius?: number;
  oracleTwapWindowsSec?: number[];
  includeOracleObservations?: boolean;
  /** Optional already-collected short-horizon samples for microstructure features. */
  activeBinSamples?: MeteoraActiveBinSample[];
  /** Optional already-fetched metrics to avoid another API/RPC snapshot. */
  marketMetrics?: MeteoraPoolMarketMetrics;
};

export type MeteoraPositionSnapshotComparison = {
  version: 1;
  pool: string;
  quoteMint: string;
  quoteSide: MeteoraPairSide;
  initialValueQuote: number | null;
  finalPrincipalValueQuote: number | null;
  feeDeltaXRaw: string;
  feeDeltaYRaw: string;
  feeValueQuote: number | null;
  finalValueQuote: number | null;
  pnlQuote: number | null;
  returnPct: number | null;
  holdValueQuote: number | null;
  excessVsHoldQuote: number | null;
  excessVsHoldPct: number | null;
  inventoryEffectVsHoldQuote: number | null;
};

export type MeteoraInfrastructureFundingPolicy = {
  /** Shared bin-array initialization is denied unless explicitly enabled. */
  allowBinArrayInit?: boolean;
  /** Shared bitmap-extension initialization is denied unless explicitly enabled. */
  allowBitmapExtensionInit?: boolean;
  /**
   * Hard ceiling for all caller-funded shared infrastructure in this operation.
   * Required whenever either allow* flag is true. Position-account rent is excluded.
   */
  maxNonRefundableLamports?: MeteoraInteger;
};

export type MeteoraInfrastructureQuote = {
  kind?: "position";
  pool: string;
  minBinId: number;
  maxBinId: number;
  strategy: MeteoraStrategy;
  binArrayCount: number | null;
  binArrayCostLamports: string;
  bitmapExtensionCostLamports: string;
  nonRefundableInfrastructureLamports: string;
  positionCostLamports: string | null;
  positionReallocCostLamports: string | null;
  transactionCount: number | null;
  requiresBinArrayInit: boolean;
  requiresBitmapExtensionInit: boolean;
  requiresNonRefundableInfrastructure: boolean;
  raw: Record<string, unknown>;
};

export type MeteoraLimitOrderSide = "ask" | "bid";

export type MeteoraLimitOrderBinInput = {
  binId: number;
  amountRaw: MeteoraInteger;
};

export type MeteoraLimitOrderInfrastructureQuote = {
  kind: "limit-order";
  pool: string;
  binIds: number[];
  minBinId: number;
  maxBinId: number;
  binArrayCount: number | null;
  binArrayCostLamports: string;
  bitmapExtensionCostLamports: string;
  nonRefundableInfrastructureLamports: string;
  /** Recoverable rent for the limit-order account itself. */
  limitOrderRentLamports: string;
  requiresBinArrayInit: boolean;
  requiresBitmapExtensionInit: boolean;
  requiresNonRefundableInfrastructure: boolean;
  raw: Record<string, unknown>;
};

export type MeteoraSharedInfrastructureQuote =
  MeteoraInfrastructureQuote | MeteoraLimitOrderInfrastructureQuote;

export type MeteoraInfrastructurePreflight = {
  checked: true;
  quote: MeteoraSharedInfrastructureQuote;
  authorization: {
    allowBinArrayInit: boolean;
    allowBitmapExtensionInit: boolean;
    maxNonRefundableLamports: string | null;
  };
};

export type MeteoraPlaceLimitOrderArgs = {
  wallet: WalletRef;
  pool: string;
  side: MeteoraLimitOrderSide;
  bins: MeteoraLimitOrderBinInput[];
  infrastructure?: MeteoraInfrastructureFundingPolicy;
};

export type MeteoraCancelLimitOrderArgs = {
  wallet: WalletRef;
  pool: string;
  limitOrder: string;
  /** Omit to cancel every currently non-empty bin. */
  binIds?: number[];
  /** Defaults to the owner wallet. */
  rentReceiver?: string;
};

export type MeteoraLimitOrderPreflight = {
  version: 1;
  observedAt: number;
  wallet: string;
  pool: string;
  side: MeteoraLimitOrderSide;
  inputMint: string;
  inputBalanceRaw: string;
  totalInputRaw: string;
  binIds: number[];
  maxBinsPerOrder: number;
  quote: MeteoraLimitOrderInfrastructureQuote;
  sharedInfrastructureAuthorized: boolean;
  safeWithoutSharedInfrastructureFunding: boolean;
  inputFundingSufficient: boolean;
  availableNativeLamports: string;
  requiredNativeLamportsBeforeNetworkFee: string;
  executable: boolean;
  safeToExecuteBeforeNetworkFee: boolean;
  estimatedNetworkFeeLamports: null;
  warnings: string[];
};

export type MeteoraLimitOrderStatus =
  "not-filled" | "partial-filled" | "fulfilled" | "unknown";

export type MeteoraLimitOrderBinSnapshot = {
  binId: number;
  empty: boolean;
  status: MeteoraLimitOrderStatus;
  raw: Record<string, unknown>;
};

export type MeteoraLimitOrderSnapshot = {
  version: 1;
  observedAt: number;
  pool: string;
  limitOrder: string;
  exists: boolean;
  owner: string | null;
  side: MeteoraLimitOrderSide | null;
  tokenX: MeteoraPoolToken;
  tokenY: MeteoraPoolToken;
  bins: MeteoraLimitOrderBinSnapshot[];
  openBinIds: number[];
  raw: Record<string, unknown> | null;
};

export type MeteoraLimitOrderVerificationChecks = {
  accountExists: boolean | null;
  accountClosed: boolean | null;
  ownerMatches: boolean | null;
  binsMatch: boolean | null;
  requestedBinsCancelled: boolean | null;
};

export type MeteoraLimitOrderVerification = {
  kind: "limit-order-placed" | "limit-order-cancelled";
  ok: boolean;
  checkedAt: number;
  attempts: number;
  pool: string;
  limitOrder: string;
  expected: {
    owner: string | null;
    binIds: number[];
    closed: boolean | null;
  };
  actual: MeteoraLimitOrderSnapshot | null;
  checks: MeteoraLimitOrderVerificationChecks;
  errors: string[];
  warnings: string[];
};

export type MeteoraExecutionVerification =
  MeteoraPositionVerification | MeteoraLimitOrderVerification;

export type MeteoraOhlcvArgs = {
  timeframe?: MeteoraTimeframe;
  /** Unix timestamp in seconds, inclusive. */
  startTime?: number;
  /** Unix timestamp in seconds, inclusive. */
  endTime?: number;
};

export type MeteoraOhlcvCandle = {
  timestamp: number;
  timestampStr: string | null;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type MeteoraOhlcvResponse = {
  pool: string;
  timeframe: MeteoraTimeframe | string | null;
  startTime: number | null;
  endTime: number | null;
  candles: MeteoraOhlcvCandle[];
};

export type MeteoraCandleRegimeMetrics = {
  version: 1;
  pool: string;
  timeframe: MeteoraTimeframe | string | null;
  candleCount: number;
  startTime: number | null;
  endTime: number | null;
  durationSec: number | null;
  startPriceYPerX: number | null;
  endPriceYPerX: number | null;
  returnPct: number | null;
  highLowSpanPct: number | null;
  realizedCloseVolPct: number | null;
  meanAbsCloseMovePct: number | null;
  medianAbsCloseMovePct: number | null;
  p90AbsCloseMovePct: number | null;
  maxAbsCloseMovePct: number | null;
  meanCandleRangePct: number | null;
  p75CandleRangePct: number | null;
  p90CandleRangePct: number | null;
  maxCandleRangePct: number | null;
  meanBodyToRangePct: number | null;
  meanCloseLocationPct: number | null;
  trendEfficiency: number | null;
  directionFlips: number;
  upCandlePct: number | null;
  downCandlePct: number | null;
  flatCandlePct: number | null;
  totalVolume: number | null;
  meanVolume: number | null;
  medianVolume: number | null;
  volumeCv: number | null;
  volumeAbsMoveCorrelation: number | null;
  recentToPriorVolumeRatio: number | null;
  recentToPriorRangeRatio: number | null;
  recentToPriorVolatilityRatio: number | null;
  startBin: number | null;
  endBin: number | null;
  displacementBins: number | null;
  totalSpanBins: number | null;
  meanCandleRangeBins: number | null;
  p75CandleRangeBins: number | null;
  p90CandleRangeBins: number | null;
  maxCandleRangeBins: number | null;
  meanAbsCloseMoveBins: number | null;
  p90AbsCloseMoveBins: number | null;
  pathBinsPerMinute: number | null;
  netBinsPerMinute: number | null;
};

export type MeteoraLiquidityDepthBin = {
  binId: number;
  distanceFromActive: number;
  xRaw: string;
  yRaw: string;
  xUi: number | null;
  yUi: number | null;
  xValueY: number | null;
  totalValueY: number | null;
};

export type MeteoraLiquidityDepthMetrics = {
  version: 1;
  pool: string;
  radius: number;
  activeBin: number;
  activePriceYPerX: number;
  binsSeen: number;
  nonEmptyBins: number;
  emptyBinPct: number | null;
  activeBinHasLiquidity: boolean;
  nearestLowerLiquidityBins: number | null;
  nearestUpperLiquidityBins: number | null;
  lowerValueY: number | null;
  activeValueY: number | null;
  upperValueY: number | null;
  totalValueY: number | null;
  xValueY: number | null;
  yValueY: number | null;
  xSharePct: number | null;
  ySharePct: number | null;
  upperVsLowerValueRatio: number | null;
  sideImbalancePct: number | null;
  topBinValueSharePct: number | null;
  weightedMeanAbsDistanceBins: number | null;
  bins: MeteoraLiquidityDepthBin[];
};

export type MeteoraPoolProfileMetrics = {
  pool: string;
  createdAtUnixSec: number | null;
  ageSec: number | null;
  currentPrice: number | null;
  binStep: number | null;
  baseFeePct: number | null;
  dynamicFeePct: number | null;
  maxFeePct: number | null;
  protocolFeePct: number | null;
  tvl: number | null;
  apr24h: number | null;
  apy24h: number | null;
  farmApr24h: number | null;
  farmApy24h: number | null;
  hasFarm: boolean | null;
  isBlacklisted: boolean | null;
  volumeByWindow: Partial<Record<MeteoraTimeframe, number>>;
  feesByWindow: Partial<Record<MeteoraTimeframe, number>>;
  feeTvlPctByWindow: Partial<Record<MeteoraTimeframe, number>>;
  cumulativeVolume: number | null;
  cumulativeTradeFee: number | null;
  cumulativeProtocolFee: number | null;
  raw: Record<string, unknown>;
};

export type MeteoraRollingPoolMetrics = {
  pool: string;
  timeframe: MeteoraTimeframe;
  tvl: number | null;
  activeTvl: number | null;
  volume: number | null;
  fee: number | null;
  /** Explicit percentage units: fee / active TVL * 100. */
  feeActiveTvlPct: number | null;
  /** Explicit percentage units: volume / active TVL * 100. */
  volumeActiveTvlPct: number | null;
  swapCount: number | null;
  uniqueTraders: number | null;
  uniqueLps: number | null;
  priceChangePct: number | null;
  raw: Record<string, unknown>;
};

export type MeteoraActiveBinSample = {
  version: 1;
  observedAt: number;
  slot: number | null;
  pool: string;
  binId: number;
  priceYPerX: number;
  pricePerLamport: number | null;
  dynamicFeePct: number | null;
};

export type MeteoraMicrostructureMetrics = {
  version: 1;
  pool: string;
  sampleCount: number;
  startAt: number | null;
  endAt: number | null;
  durationSec: number | null;
  meanSampleIntervalSec: number | null;
  p90SampleIntervalSec: number | null;
  maxSampleIntervalSec: number | null;
  startBin: number | null;
  endBin: number | null;
  displacementBins: number | null;
  totalPathBins: number | null;
  totalSpanBins: number | null;
  pathBinsPerMinute: number | null;
  netBinsPerMinute: number | null;
  trendEfficiency: number | null;
  binChanges: number;
  binChangesPerMinute: number | null;
  stationaryTimePct: number | null;
  uniqueBinsVisited: number;
  directionFlips: number;
  meanAbsMovePerChangeBins: number | null;
  medianAbsMovePerChangeBins: number | null;
  p90AbsMovePerChangeBins: number | null;
  maxAbsMovePerChangeBins: number | null;
  realizedStepVolBins: number | null;
  meanDwellSec: number | null;
  medianDwellSec: number | null;
  p90DwellSec: number | null;
  maxDwellSec: number | null;
  startPriceYPerX: number | null;
  endPriceYPerX: number | null;
  priceReturnPct: number | null;
  highLowSpanPct: number | null;
  realizedLogVolPct: number | null;
  meanDynamicFeePct: number | null;
  p90DynamicFeePct: number | null;
};

export type MeteoraRangePathMetrics = {
  version: 1;
  pool: string;
  minBinId: number;
  maxBinId: number;
  width: number;
  sampleCount: number;
  durationSec: number | null;
  inRangeTimePct: number | null;
  inRangeSec: number | null;
  outOfRangeSec: number | null;
  entries: number;
  exits: number;
  finalInRange: boolean | null;
  maxOutOfRangeDistanceBins: number | null;
  firstExitAfterSec: number | null;
  firstEntryAfterSec: number | null;
  longestInRangeSec: number | null;
  longestOutOfRangeSec: number | null;
};

export type MeteoraOracleSnapshotArgs = {
  /** TWAP windows in seconds. Default: 60, 300, 900, 3600. */
  twapWindowsSec?: number[];
  /** Include decoded observations. Default false. */
  includeObservations?: boolean;
  /** Refresh the underlying DLMM pool before reading. Default true. */
  refresh?: boolean;
};

export type MeteoraOracleObservation = {
  index: number;
  initialized: boolean;
  cumulativeActiveBinId: string;
  createdAtUnixSec: number | null;
  lastUpdatedAtUnixSec: number | null;
};

export type MeteoraOracleTwapWindow = {
  requestedSec: number;
  covered: boolean;
  durationSec: number | null;
  activeBin: number | null;
  uiPriceYPerX: number | null;
  spotDeviationBins: number | null;
  spotVsTwapPct: number | null;
};

export type MeteoraOracleSnapshot = {
  version: 1;
  observedAt: number;
  pool: string;
  supported: boolean;
  available: boolean;
  oracleAddress: string | null;
  currentTimestampUnixSec: number;
  currentTimestampSource: "pool-clock" | "rpc-block-time" | "local-clock";
  spotBin: number;
  spotPriceYPerX: number;
  metadata: {
    idx: number | null;
    activeSize: number | null;
    length: number | null;
    raw: Record<string, unknown>;
  } | null;
  initializedObservationCount: number;
  earliestObservationAtUnixSec: number | null;
  latestObservationAtUnixSec: number | null;
  latestObservationAgeSec: number | null;
  maxDurationSec: number | null;
  twaps: MeteoraOracleTwapWindow[];
  observations: MeteoraOracleObservation[] | null;
  error: string | null;
};

export type MeteoraPoolMarketMetrics = {
  version: 2;
  observedAt: number;
  pool: string;
  state: MeteoraPoolState;
  activeBinSample: MeteoraActiveBinSample;
  oracle: MeteoraOracleSnapshot;
  profile: MeteoraPoolProfileMetrics;
  rolling: MeteoraRollingPoolMetrics | null;
  ohlcv: MeteoraOhlcvResponse;
  candleRegime: MeteoraCandleRegimeMetrics;
  liquidityDepth: MeteoraLiquidityDepthMetrics;
};

export type MeteoraWalletAccountingSnapshot = {
  observedAt: number;
  nativeLamports: string;
  tokenXRaw: string;
  tokenYRaw: string;
};

export type MeteoraPositionAccountingSnapshot = {
  observedAt: number;
  exists: boolean;
  accountLamports: string;
  totalXRaw: string;
  totalYRaw: string;
  feeXRaw: string;
  feeYRaw: string;
};

export type MeteoraExecutionAccounting = {
  version: 1;
  complete: boolean;
  wallet: string;
  pool: string;
  position: string | null;
  tokenXMint: string;
  tokenYMint: string;
  before: {
    wallet: MeteoraWalletAccountingSnapshot;
    position: MeteoraPositionAccountingSnapshot | null;
  };
  after: {
    wallet: MeteoraWalletAccountingSnapshot | null;
    position: MeteoraPositionAccountingSnapshot | null;
  };
  walletDelta: {
    /** SPL-token-account delta only. Native SOL is deliberately separate. */
    tokenXRaw: string | null;
    /** SPL-token-account delta only. Native SOL is deliberately separate. */
    tokenYRaw: string | null;
    nativeLamports: string | null;
  };
  liquidity: {
    /** Requested raw contribution from the prepared open/add-liquidity call. */
    requestedDepositXRaw: string | null;
    /** Requested raw contribution from the prepared open/add-liquidity call. */
    requestedDepositYRaw: string | null;
    preActionPositionXRaw: string;
    preActionPositionYRaw: string;
    postActionPositionXRaw: string | null;
    postActionPositionYRaw: string | null;
    /** Observed position inventory change, not inferred from native wallet SOL. */
    positionIncreaseXRaw: string | null;
    positionIncreaseYRaw: string | null;
    positionDecreaseXRaw: string | null;
    positionDecreaseYRaw: string | null;
  };
  positionFees: {
    preActionUnclaimedXRaw: string | null;
    preActionUnclaimedYRaw: string | null;
    postActionUnclaimedXRaw: string | null;
    postActionUnclaimedYRaw: string | null;
    counterIncreaseXRaw: string | null;
    counterIncreaseYRaw: string | null;
    counterDecreaseXRaw: string | null;
    counterDecreaseYRaw: string | null;
  };
  positionRent: {
    beforeLamports: string | null;
    afterLamports: string | null;
    lockedLamports: string | null;
    returnedLamports: string | null;
  };
  /** Present for swap operations; null for liquidity/claim/limit-order actions. */
  swap: {
    inputMint: string;
    outputMint: string;
    requestedInputRaw: string | null;
    quotedOutputRaw: string | null;
    actualInputDebitedRaw: string | null;
    actualOutputCreditedRaw: string | null;
  } | null;
  /** Present for native Meteora limit-order placement/cancellation. */
  limitOrder: {
    address: string;
    side: MeteoraLimitOrderSide | null;
    inputMint: string | null;
    requestedInputRaw: string | null;
    actualInputDebitedRaw: string | null;
    returnedXRaw: string | null;
    returnedYRaw: string | null;
    beforeAccountLamports: string | null;
    afterAccountLamports: string | null;
    rentLockedLamports: string | null;
    rentReturnedLamports: string | null;
  } | null;
  networkFeeLamports: string | null;
  infrastructure: {
    /** Quote produced before the transaction. Position-account rent is excluded. */
    quotedNonRefundableLamports: string;
    quotedBinArrayLamports: string;
    quotedBitmapExtensionLamports: string;
    authorizedMaximumLamports: string | null;
    explicitlyAuthorized: boolean;
  } | null;
  /**
   * Accounting is observational. In particular, native SOL is never inferred to be
   * WSOL principal. Warnings explain any post-write RPC gaps or unavailable fee data.
   */
  warnings: string[];
};

export type MeteoraExecutionOptions = {
  /**
   * Must be true for any on-chain write. This is intentionally separate from
   * SOLARD_ENABLE_LIVE_TRADES so an agent must opt in at both layers.
   */
  live: boolean;
  commitment?: Commitment;
  skipPreflight?: boolean;
  simulate?: boolean;
  maxRetries?: number;
};

export type MeteoraPreparedTransactions = {
  kind:
    | "open-position"
    | "add-liquidity"
    | "remove-liquidity"
    | "close-position"
    | "claim-fees"
    | "claim-rewards"
    | "claim-position-rewards"
    | "claim-all-fees"
    | "claim-all-lm-rewards"
    | "claim-all-rewards"
    | "swap-exact-in"
    | "swap-exact-out"
    | "place-limit-order"
    | "cancel-limit-order"
    | "close-limit-order";
  wallet: WalletRef;
  pool: string;
  transactions: MeteoraTransaction[];
  extraSigners: Keypair[];
  position?: string;
  limitOrder?: string;
  /** Required attestation for open/add-liquidity/place-limit-order prepared by Solard. */
  infrastructurePreflight?: MeteoraInfrastructurePreflight;
  metadata?: Record<string, unknown>;
};

export type MeteoraPositionVerificationChecks = {
  accountExists: boolean | null;
  accountClosed: boolean | null;
  poolMatches: boolean | null;
  ownerMatches: boolean | null;
  rangeMatches: boolean | null;
  absentFromWalletPool: boolean | null;
};

export type MeteoraPositionVerification = {
  kind:
    "position-open" | "position-present" | "position-closed" | "not-applicable";
  ok: boolean;
  checkedAt: number;
  attempts: number;
  pool: string;
  position: string | null;
  expected: {
    owner: string | null;
    minBinId: number | null;
    maxBinId: number | null;
  };
  actual: MeteoraPositionSnapshot | null;
  checks: MeteoraPositionVerificationChecks;
  errors: string[];
  warnings: string[];
};

export type MeteoraPositionVerificationOptions = {
  commitment?: Commitment;
  /** Number of chain re-reads before verification fails. Defaults to 4. */
  attempts?: number;
  /** Delay between verification attempts. Defaults to 400ms. */
  retryDelayMs?: number;
};

export type MeteoraVerifyPositionArgs = MeteoraPositionVerificationOptions & {
  pool: string;
  position: string;
  /** WalletRef or public-address string resolvable by the configured Solard host. */
  wallet?: WalletRef;
  minBinId?: number;
  maxBinId?: number;
};

export type MeteoraExecutionResult = {
  kind: MeteoraPreparedTransactions["kind"];
  pool: string;
  position?: string;
  limitOrder?: string;
  signatures: string[];
  /** Present for position-mutating writes prepared/executed by the current SDK. */
  accounting?: MeteoraExecutionAccounting;
  /** Present when executePreparedAndVerify() or a verified convenience method is used. */
  verification?: MeteoraExecutionVerification;
};

export type MeteoraPoolToken = {
  mint: string;
  decimals: number | null;
  reserve: string | null;
  tokenProgram: string | null;
};

export type MeteoraActiveBin = {
  pool: string;
  binId: number;
  price: string;
  pricePerLamport: string;
};

export type MeteoraPoolState = {
  pool: string;
  tokenX: MeteoraPoolToken;
  tokenY: MeteoraPoolToken;
  binStep: number | null;
  activeId: number | null;
  activeBin: MeteoraActiveBin;
  feeInfo: Record<string, unknown> | null;
  dynamicFee: string | null;
};

export type MeteoraPositionSnapshot = {
  position: string;
  pool: string;
  owner: string | null;
  activeBin: number | null;
  lowerBin: number | null;
  upperBin: number | null;
  inRange: boolean | null;
  tokenX: MeteoraPoolToken;
  tokenY: MeteoraPoolToken;
  totalXRaw: string;
  totalYRaw: string;
  feeXRaw: string;
  feeYRaw: string;
  claimedFeeXRaw: string | null;
  claimedFeeYRaw: string | null;
  rewards: unknown[];
};

export type MeteoraWalletPositions = {
  wallet: string;
  totalPositions: number;
  positions: MeteoraPositionSnapshot[];
};

export type MeteoraPoolDiscoveryToken = {
  mint: string | null;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
};

export type MeteoraPoolDiscoveryCandidateV1 = {
  schema: typeof METEORA_POOL_DISCOVERY_SCHEMA_V1;
  version: 1;
  observedAtMs: number;
  timeframe: MeteoraTimeframe;
  pool: string;
  name: string | null;
  tokenX: MeteoraPoolDiscoveryToken;
  tokenY: MeteoraPoolDiscoveryToken;
  createdAtUnixSec: number | null;
  ageSec: number | null;
  currentPriceYPerX: number | null;
  binStep: number | null;
  baseFeePct: number | null;
  dynamicFeePct: number | null;
  maxFeePct: number | null;
  protocolFeePct: number | null;
  tvlUsd: number | null;
  activeTvlUsd: number | null;
  volumeUsd: number | null;
  feeUsd: number | null;
  /** Meteora Data API fee_tvl_ratio for the selected rolling window; units preserved as API ratio semantics. */
  feeTvlRatio: number | null;
  /** Derived as feeUsd / activeTvlUsd * 100 when both are available. */
  feeActiveTvlPct: number | null;
  /** Derived as volumeUsd / activeTvlUsd * 100 when both are available. */
  volumeActiveTvlPct: number | null;
  priceChangePct: number | null;
  swapCount: number | null;
  uniqueTraders: number | null;
  uniqueLps: number | null;
  aprPct: number | null;
  apyPct: number | null;
  hasFarm: boolean | null;
  isBlacklisted: boolean | null;
  quality: {
    identityComplete: boolean;
    tokenMetadataComplete: boolean;
    rollingMetricsPresent: number;
    rollingMetricsExpected: 8;
    feeActiveTvlDerived: boolean;
    volumeActiveTvlDerived: boolean;
  };
  raw: Record<string, unknown> | null;
};

export type MeteoraPoolDiscoveryArgs = {
  /** 1-based page number. Default 1. */
  page?: number;
  /** Official Data API supports up to 1000 pool rows per page. Default 100. */
  pageSize?: number;
  /** Search by pool name, token, mint, or address. */
  query?: string;
  /** Meteora Data API sort expression, e.g. `volume_5m:desc`. */
  sortBy?: string;
  /** Meteora Data API filter expression. */
  filterBy?: string;
  /** Window used to normalize rolling volume/fee/price-change fields. Default 5m. */
  timeframe?: MeteoraTimeframe;
  /** Include the complete normalized Data API row. Default false. */
  includeRaw?: boolean;
};

export type MeteoraPoolDiscoveryPageV1 = {
  schema: typeof METEORA_POOL_DISCOVERY_SCHEMA_V1;
  version: 1;
  observedAtMs: number;
  timeframe: MeteoraTimeframe;
  page: number;
  pageSize: number;
  total: number | null;
  totalPages: number | null;
  returned: number;
  droppedMalformedRows: number;
  query: string | null;
  sortBy: string | null;
  filterBy: string | null;
  pools: MeteoraPoolDiscoveryCandidateV1[];
};

export type MeteoraPoolSearchResult = {
  pool: string;
  name: string | null;
  binStep: number | null;
  feePct: number | null;
  tvl: number | null;
  volume24h: number | null;
  tokenX: { symbol: string | null; mint: string | null };
  tokenY: { symbol: string | null; mint: string | null };
  raw: Record<string, unknown>;
};

export type MeteoraDiscoverPoolsArgs = {
  pageSize?: number;
  timeframe?: MeteoraTimeframe;
  /** Omit category for the broad discovery universe (the Meteora UI's All tab). */
  category?: MeteoraPoolCategory;
  /**
   * Meteora discovery filter expression, e.g.
   * "pool_type=dlmm&&tvl>=10000&&volume>=1000".
   */
  filterBy?: string;
};

export type MeteoraOpenPositionArgs = {
  wallet: WalletRef;
  pool: string;
  strategy?: MeteoraStrategy;
  amountXRaw?: MeteoraInteger;
  amountYRaw?: MeteoraInteger;
  amountX?: MeteoraUiAmount;
  amountY?: MeteoraUiAmount;
  minBinId?: number;
  maxBinId?: number;
  binsBelow?: number;
  binsAbove?: number;
  downsidePct?: number;
  upsidePct?: number;
  slippageBps?: number;
  /** Default-deny policy for caller-funded shared Meteora infrastructure. */
  infrastructure?: MeteoraInfrastructureFundingPolicy;
};

export type MeteoraAddLiquidityArgs = {
  wallet: WalletRef;
  pool: string;
  position: string;
  strategy?: MeteoraStrategy;
  amountXRaw?: MeteoraInteger;
  amountYRaw?: MeteoraInteger;
  amountX?: MeteoraUiAmount;
  amountY?: MeteoraUiAmount;
  minBinId?: number;
  maxBinId?: number;
  slippageBps?: number;
  /** Default-deny policy for caller-funded shared Meteora infrastructure. */
  infrastructure?: MeteoraInfrastructureFundingPolicy;
};

export type MeteoraRemoveLiquidityArgs = {
  wallet: WalletRef;
  pool: string;
  position: string;
  bps?: number;
  fromBinId?: number;
  toBinId?: number;
  claimAndClose?: boolean;
  skipUnwrapSol?: boolean;
};

export type MeteoraPositionActionArgs = {
  wallet: WalletRef;
  pool: string;
  position: string;
};

export type MeteoraMovePositionArgs = {
  wallet: WalletRef;
  pool: string;
  /** Exact source position whose attributable inventory is the only LP principal source. */
  position: string;
  strategy?: MeteoraStrategy;
  minBinId?: number;
  maxBinId?: number;
  binsBelow?: number;
  binsAbove?: number;
  downsidePct?: number;
  upsidePct?: number;
  slippageBps?: number;
  /** Default-deny policy for shared Meteora infrastructure required by the target range. */
  infrastructure?: MeteoraInfrastructureFundingPolicy;
};

export type MeteoraMoveCapitalAttribution = {
  sourcePosition: string;
  principalSource: "source-position-only";
  /** Source position inventory + unclaimed fees immediately before close. */
  sourceAttributableXRaw: string;
  sourceAttributableYRaw: string;
  /** Positive SPL wallet deltas produced by the source close, before source-cap clipping. */
  observedRecoveredXRaw: string;
  observedRecoveredYRaw: string;
  /** Amounts eligible to become new LP principal: min(observed close delta, source attributable cap). */
  eligibleReopenXRaw: string;
  eligibleReopenYRaw: string;
  /** Amounts requested for the replacement position. */
  reopenedXRaw: string;
  reopenedYRaw: string;
  freshWalletPrincipalXRaw: "0";
  freshWalletPrincipalYRaw: "0";
  nativeSolUsedAsPrincipal: false;
  marketSwapPerformed: false;
  closeUsedSkipUnwrapSol: true;
};

export type MeteoraMovePositionResult = {
  version: 1;
  wallet: string;
  pool: string;
  sourcePosition: string;
  targetPosition: string;
  sourceSnapshot: MeteoraPositionSnapshot;
  attribution: MeteoraMoveCapitalAttribution;
  close: MeteoraExecutionResult;
  open: MeteoraExecutionResult;
};

export type MeteoraSwapExactInArgs = {
  wallet: WalletRef;
  pool: string;
  /** true = token X -> token Y, false = token Y -> token X */
  swapForY: boolean;
  amountInRaw?: MeteoraInteger;
  amountIn?: MeteoraUiAmount;
  slippageBps?: number;
  allowPartialFill?: boolean;
  maxExtraBinArrays?: number;
};

export type MeteoraSwapExactOutArgs = {
  wallet: WalletRef;
  pool: string;
  /** true = token X -> token Y, false = token Y -> token X */
  swapForY: boolean;
  amountOutRaw?: MeteoraInteger;
  amountOut?: MeteoraUiAmount;
  slippageBps?: number;
  maxExtraBinArrays?: number;
};

export type MeteoraSwapQuote = {
  pool: string;
  swapForY: boolean;
  inputMint: string;
  outputMint: string;
  inAmountRaw: string;
  outAmountRaw: string;
  minOutAmountRaw?: string;
  maxInAmountRaw?: string;
  feeRaw: string | null;
  protocolFeeRaw: string | null;
  priceImpact: string | null;
  endPrice: string | null;
  binArrays: string[];
  raw: unknown;
};
