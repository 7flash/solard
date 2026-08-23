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

export type MeteoraInfrastructurePreflight = {
  checked: true;
  quote: MeteoraInfrastructureQuote;
  authorization: {
    allowBinArrayInit: boolean;
    allowBitmapExtensionInit: boolean;
    maxNonRefundableLamports: string | null;
  };
};

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
    | "swap-exact-out";
  wallet: WalletRef;
  pool: string;
  transactions: MeteoraTransaction[];
  extraSigners: Keypair[];
  position?: string;
  /** Required attestation for open/add-liquidity prepared by Solard. */
  infrastructurePreflight?: MeteoraInfrastructurePreflight;
  metadata?: Record<string, unknown>;
};

export type MeteoraExecutionResult = {
  kind: MeteoraPreparedTransactions["kind"];
  pool: string;
  position?: string;
  signatures: string[];
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
