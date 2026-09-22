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
  | "REFERENCE_PRICE_UNAVAILABLE"
  | "POOL_PRICE_DESYNCHRONIZED"
  | "POOL_PRICE_SYNC_UNAVAILABLE"
  | "POOL_PRICE_SYNC_FAILED"
  | "LIMIT_ORDER_UNSUPPORTED"
  | "LIMIT_ORDER_NOT_FOUND"
  | "LIMIT_ORDER_NOT_FULLY_FILLED"
  | "LIMIT_ORDER_PROVENANCE_MISMATCH"
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

export type MeteoraReferencePriceSource = "jupiter-swap-v2";

export type MeteoraExecutableReferenceQuoteLeg = {
  inputMint: string;
  outputMint: string;
  inAmountRaw: string;
  outAmountRaw: string;
  router: string | null;
  mode: string | null;
  priceImpactPct: number | null;
  routeAmmKeys: string[];
  routeLabels: string[];
  targetPoolSeenInRoute: boolean;
};

export type MeteoraExecutableReferencePrice = {
  version: 1;
  source: MeteoraReferencePriceSource;
  observedAt: number;
  baseMint: string;
  quoteMint: string;
  /** Fixed quote-side notional used for the buy leg. */
  quoteNotionalRaw: string;
  /** Base amount returned by the buy leg and re-used as input for the sell leg. */
  roundTripBaseRaw: string;
  bidBaseInQuote: number;
  askBaseInQuote: number;
  midpointBaseInQuote: number;
  spreadPct: number | null;
  independentOfTargetPool: boolean;
  buyBase: MeteoraExecutableReferenceQuoteLeg;
  sellBase: MeteoraExecutableReferenceQuoteLeg;
};

export type MeteoraExecutableReferencePriceArgs = {
  pool: string;
  quoteMint: string;
  /**
   * Optional executable reference quote size in raw quote-token units.
   * When omitted, Solard uses 0.01 quote-token UI units (or one raw unit
   * when the mint has fewer than two decimals). The resolved raw notional is
   * always returned in the typed reference receipt.
   */
  referenceQuoteNotionalRaw?: MeteoraInteger;
  /**
   * Fail closed when Jupiter cannot produce a route independent of this exact pool.
   * Defaults to true.
   */
  requireIndependentReference?: boolean;
};

export type MeteoraPoolPriceSanityArgs = MeteoraExecutableReferencePriceArgs & {
  /**
   * Optional application tolerance for the standalone sanity helper.
   * Defaults to 0, meaning the pool must lie inside the fresh executable bid/ask band.
   * Pool-price-sync preflight itself reports deviationBps so agent policy can choose
   * its own threshold without feeding a market price into the SDK.
   */
  maxDeviationPct?: number;
};

export type MeteoraPoolPriceSanity = {
  version: 1;
  observedAt: number;
  pool: string;
  pair: MeteoraPairDescriptor;
  poolActiveBin: number;
  poolPriceYPerX: number;
  poolBaseInQuote: number;
  reference: MeteoraExecutableReferencePrice;
  marketBidBaseInQuote: number;
  marketAskBaseInQuote: number;
  marketMidBaseInQuote: number;
  /** Signed pool-vs-market-mid difference: (pool / mid - 1) * 100. */
  signedMidDeviationPct: number;
  absMidDeviationPct: number;
  /**
   * Zero while pool price is inside the executable bid/ask band; otherwise the
   * percentage distance to the nearest executable band edge.
   */
  outsideExecutableBandDeviationPct: number;
  maxDeviationPct: number;
  synchronized: boolean;
};

export type MeteoraPoolPriceSyncTargetPolicy = "midpoint" | "nearest-band";

export type MeteoraPoolPriceSyncInfrastructureQuote = {
  kind: "price-sync";
  pool: string;
  targetBinId: number;
  binArrayCount: 0;
  binArrayCostLamports: "0";
  bitmapExtensionCostLamports: string;
  nonRefundableInfrastructureLamports: string;
  bitmapExtensionRequired: boolean;
  bitmapExtensionAddress: string | null;
  bitmapExtensionInitialized: boolean | null;
  requiresBinArrayInit: false;
  requiresBitmapExtensionInit: boolean;
  requiresNonRefundableInfrastructure: boolean;
  raw: Record<string, unknown>;
};

export type MeteoraPoolPriceSyncPreflightArgs = MeteoraPoolPriceSanityArgs & {
  wallet: WalletRef;
  targetPolicy?: MeteoraPoolPriceSyncTargetPolicy;
  infrastructure?: MeteoraInfrastructureFundingPolicy;
  commitment?: Commitment;
};

export type MeteoraPoolPriceSyncPreflight = {
  version: 2;
  observedAt: number;
  wallet: string;
  pool: string;

  /** Canonical sync contract used by autonomous callers. */
  activeBinBefore: number;
  targetBin: number;
  poolPriceBaseInQuote: number;
  marketPriceBaseInQuote: number;
  /** Absolute pool-vs-executable-mid deviation in basis points. */
  deviationBps: number;
  /** Distance outside the executable bid/ask band in basis points. */
  outsideExecutableBandDeviationBps: number;
  canSync: boolean;
  transactionCount: number;
  estimatedNetworkFeeLamports: bigint;
  networkFeeEstimateComplete: boolean;
  requiredSigners: Array<{ pubkey: string; role: "wallet" }>;
  missingRequiredSignerPubkeys: string[];
  /** go_to_a_bin does not create recoverable user-owned position/order state. */
  recoverableRentLamports: bigint;
  /** Persistent bitmap/bin infrastructure only; autonomous callers reject nonzero. */
  persistentInfrastructureLamports: bigint;
  safeToExecute: boolean;

  /** Full typed reference/safety evidence retained for forensic callers. */
  sanity: MeteoraPoolPriceSanity;
  requiresSync: boolean;
  targetPolicy: MeteoraPoolPriceSyncTargetPolicy;
  targetBaseInQuote: number;
  /** Exact Y-per-X UI price supplied to Meteora syncWithMarketPrice(). */
  targetPriceYPerX: number;
  /** @deprecated Use targetBin. */
  targetBinId: number;
  blockedByLiquidity: boolean;
  blockedByBinResolution: boolean;
  infrastructure: MeteoraPoolPriceSyncInfrastructureQuote;
  sharedInfrastructureAuthorized: boolean;
  safeWithoutSharedInfrastructureFunding: boolean;
  /** @deprecated Use requiredSigners / missingRequiredSignerPubkeys. */
  requiredSignerPubkeys: string[];
};

export type MeteoraPoolPriceSyncVerifiedResult = {
  version: 1;
  pool: string;
  signature: string;
  activeBinBefore: number;
  activeBinAfter: number;
  targetBin: number;
  poolPriceBefore: number;
  poolPriceAfter: number;
  /** Executable external midpoint converted to the exact Y/X target used by Meteora. */
  marketPriceUsed: number;
  deviationBeforeBps: number;
  deviationAfterBps: number;
  estimatedNetworkFeeLamports: bigint;
  actualNetworkFeeLamports: bigint;
  verified: true;
  /** Full evidence for logging/recovery without forcing callers into generic result shapes. */
  preflight: MeteoraPoolPriceSyncPreflight;
  execution: MeteoraExecutionResult;
  verification: MeteoraPoolPriceSyncVerification;
};

export type MeteoraPoolPriceSyncVerification = {
  kind: "pool-price-synced";
  ok: boolean;
  checkedAt: number;
  attempts: number;
  pool: string;
  expected: {
    targetBinId: number;
    targetBaseInQuote: number;
    maxDeviationPct: number;
    referenceQuoteNotionalRaw: string;
  };
  actual: MeteoraPoolPriceSanity | null;
  checks: {
    targetBinReached: boolean | null;
    synchronizedToFreshReference: boolean | null;
  };
  errors: string[];
  warnings: string[];
};

export type MeteoraWalletPoolTokenBalance = MeteoraPoolToken & {
  /** Aggregate wallet SPL balance for this mint across all owned token accounts. */
  rawTotal: string;
  accountCount: number;
};

export type MeteoraWalletPoolBalances = {
  version: 1;
  observedAt: number;
  wallet: string;
  pool: string;
  nativeLamports: string;
  tokenX: MeteoraWalletPoolTokenBalance;
  tokenY: MeteoraWalletPoolTokenBalance;
  /** @deprecated Use tokenX.rawTotal. */
  tokenXRaw: string;
  /** @deprecated Use tokenY.rawTotal. */
  tokenYRaw: string;
  /** @deprecated Use tokenX.accountCount. */
  tokenXAccountCount: number;
  /** @deprecated Use tokenY.accountCount. */
  tokenYAccountCount: number;
};

export type MeteoraOpenBatchCandidate = {
  id: string;
  strategy?: MeteoraStrategy;
  minBinId: number;
  maxBinId: number;
  amountXRaw?: MeteoraInteger;
  amountYRaw?: MeteoraInteger;
  /** Used only to build unsigned transactions for tx-count/signer/fee estimation. */
  slippageBps?: number;
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

export type MeteoraBinArrayPreflight = {
  index: number;
  address: string;
  initialized: boolean;
};

export type MeteoraOpenBatchPreflightCandidate = {
  id: string;
  strategy: MeteoraStrategy;
  minBinId: number;
  maxBinId: number;
  width: number;
  positionKind: "standard" | "extended";
  /** True only when this candidate can be built without caller-funded shared pool infrastructure. */
  executable: boolean;
  errorCode: MeteoraErrorCode | null;
  errorMessage: string | null;
  infrastructure: MeteoraInfrastructureQuote | null;
  /** Actual unsigned transaction count produced by Solard's current builder when safe to build. */
  transactionCount: number | null;
  /** Meteora quote's transaction count, retained as a diagnostic. */
  quotedTransactionCount: number | null;
  /** Union of all signer pubkeys required across the unsigned preflight transactions. */
  requiredSignerPubkeys: string[];
  /** Signer provenance; generated-position pubkeys are intentionally ephemeral to this read-only preflight. */
  requiredSigners: Array<{
    pubkey: string;
    role: "wallet" | "generated-position" | "unknown";
  }>;
  /** Required signers Solard cannot provide from the wallet + generated position keypair. */
  missingRequiredSignerPubkeys: string[];
  /** Estimated current network fee for the unsigned transaction set. */
  estimatedNetworkFeeLamports: string | null;
  networkFeeEstimateComplete: boolean;
  /** Recoverable account rent for the initial position account(s). */
  positionRentLamports: string | null;
  /** Recoverable dynamic-position realloc rent. */
  positionReallocRentLamports: string | null;
  /** Total recoverable position rent = positionRent + realloc rent. */
  refundablePositionLamports: string | null;
  /** @deprecated Alias of positionRentLamports. */
  positionCostLamports: string | null;
  /** @deprecated Alias of positionReallocRentLamports. */
  positionReallocCostLamports: string | null;
  /** @deprecated Alias of refundablePositionLamports. */
  refundablePositionLamportsUpperBound: string | null;
  nonRefundableInfrastructureLamports: string;
  /** @deprecated Alias of nonRefundableInfrastructureLamports. */
  nonRefundableInfrastructureLamportsUpperBound: string;
  requiredBinArrays: MeteoraBinArrayPreflight[];
  missingBinArrays: Array<{ index: number; address: string }>;
  bitmapExtensionRequired: boolean;
  bitmapExtensionAddress: string | null;
  bitmapExtensionInitialized: boolean | null;
  requiresSharedInfrastructure: boolean;
  sharedInfrastructureAuthorized: boolean;
  safeWithoutSharedInfrastructureFunding: boolean;
  requestedAmountXRaw: string;
  requestedAmountYRaw: string;
};

export type MeteoraOpenBatchPreflight = {
  version: 2;
  observedAt: number;
  wallet: string;
  pool: string;
  /** True only when every requested candidate is executable under the zero-shared-infrastructure safety rule. */
  safeToBuild: boolean;
  /** All requested principal for the executable subset can be sourced from the wallet. */
  principalFundingSufficient: boolean;
  /**
   * True only when every requested candidate is executable, fee estimation is complete,
   * principal is funded, and native SOL covers principal + recoverable rent + estimated
   * network fees + reserve. Any missing bin-array/bitmap initialization makes this false.
   */
  safeToExecute: boolean;
  /** @deprecated Alias of safeToExecute. */
  safeToExecuteBeforeNetworkFee: boolean;
  availableNativeLamports: string;
  balances: MeteoraWalletPoolBalances;
  nativeReserveLamports: string;
  candidates: MeteoraOpenBatchPreflightCandidate[];
  total: {
    executableCandidates: number;
    rejectedCandidates: number;
    allCandidatesExecutable: boolean;
    networkFeeEstimateComplete: boolean;
    refundablePositionLamports: string | null;
    /** @deprecated Alias of refundablePositionLamports. */
    refundablePositionLamportsUpperBound: string | null;
    nonRefundableInfrastructureLamports: string;
    /** @deprecated Alias of nonRefundableInfrastructureLamports. */
    nonRefundableInfrastructureLamportsUpperBound: string;
    estimatedNetworkFeeLamports: string | null;
    requiredNativeLamportsExcludingPrincipal: string | null;
    /** @deprecated Compatibility field from v1; now includes network fee when known. */
    requiredNativeLamportsBeforeNetworkFeeUpperBound: string | null;
    requestedPrincipalXRaw: string;
    requestedPrincipalYRaw: string;
    /**
     * Requested WSOL-side principal. Solard currently uses Meteora's default SOL
     * wrapping path for position opens, so this is conservatively treated as native SOL.
     */
    requestedWsolPrincipalLamports: string;
    /** Recoverable rent + estimated network fees + reserve + WSOL principal. */
    requiredNativeLamportsIncludingWsolPrincipal: string | null;
    /** @deprecated Alias of requiredNativeLamportsIncludingWsolPrincipal. */
    requiredNativeLamportsIncludingWsolPrincipalBeforeNetworkFeeUpperBound:
      string | null;
    /**
     * Native SOL remaining for WSOL principal after reserving recoverable rent,
     * estimated network fees, and nativeReserveLamports for the executable subset.
     */
    maxDeployableWsolPrincipalLamports: string | null;
    /** Proportional scale for requested WSOL principal, 0..10000 bps. */
    suggestedWsolPrincipalScaleBps: number | null;
    tokenXPrincipalSufficient: boolean;
    tokenYPrincipalSufficient: boolean;
    nativeFundingSufficient: boolean | null;
    /** @deprecated Alias of nativeFundingSufficient. */
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
  /** Pool bin step in basis points. Geometry metadata; not part of the learned-feature semantics hash. */
  binStep: number | null;
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
  /** Number of currently missing bin arrays required by this range. */
  binArrayCount: number | null;
  binArrayCostLamports: string;
  bitmapExtensionCostLamports: string;
  nonRefundableInfrastructureLamports: string;
  /** Recoverable base position-account rent, normalized to lamports. */
  positionCostLamports: string | null;
  /** Recoverable dynamic-position realloc rent, normalized to lamports. */
  positionReallocCostLamports: string | null;
  transactionCount: number | null;
  requiredBinArrays?: MeteoraBinArrayPreflight[];
  missingBinArrays?: Array<{ index: number; address: string }>;
  bitmapExtensionRequired?: boolean;
  bitmapExtensionAddress?: string | null;
  bitmapExtensionInitialized?: boolean | null;
  requiresBinArrayInit: boolean;
  requiresBitmapExtensionInit: boolean;
  requiresNonRefundableInfrastructure: boolean;
  /** Raw upstream quote. Current Meteora quoteCreatePosition cost fields are SOL-denominated. */
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
  /** Number of currently missing bin-array accounts touched by these bins. */
  binArrayCount: number | null;
  binArrayCostLamports: string;
  bitmapExtensionCostLamports: string;
  nonRefundableInfrastructureLamports: string;
  /** Recoverable rent for the limit-order account itself. */
  limitOrderRentLamports: string;
  requiredBinArrays?: MeteoraBinArrayPreflight[];
  missingBinArrays?: Array<{ index: number; address: string }>;
  bitmapExtensionRequired?: boolean;
  bitmapExtensionAddress?: string | null;
  bitmapExtensionInitialized?: boolean | null;
  requiresBinArrayInit: boolean;
  requiresBitmapExtensionInit: boolean;
  requiresNonRefundableInfrastructure: boolean;
  raw: Record<string, unknown>;
};

export type MeteoraSharedInfrastructureQuote =
  | MeteoraInfrastructureQuote
  | MeteoraLimitOrderInfrastructureQuote
  | MeteoraPoolPriceSyncInfrastructureQuote;

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

export type MeteoraSettleLimitOrderArgs = {
  wallet: WalletRef;
  pool: string;
  limitOrder: string;
  /** Defaults to the owner wallet. */
  rentReceiver?: string;
  /**
   * When true, refuse to cancel a still-working order. Useful for autonomous
   * "harvest only when fully filled" maintenance. Defaults to false.
   */
  requireFullyFilled?: boolean;
};

export type MeteoraLimitOrderGeometryPreflightArgs = {
  pool: string;
  side: MeteoraLimitOrderSide;
  binIds: number[];
  infrastructure?: MeteoraInfrastructureFundingPolicy;
  commitment?: Commitment;
};

export type MeteoraLimitOrderGeometryBin = {
  binId: number;
  /**
   * Aggregate opposite-token liquidity observed in the target bin, when the
   * installed Meteora parser exposes it. This is a conservative collision signal;
   * it is not claimed to be limit-order-only liquidity.
   */
  oppositeSideLiquidityRaw: string | null;
  raw: Record<string, unknown>;
};

export type MeteoraLimitOrderGeometryPreflight = {
  version: 1;
  observedAt: number;
  pool: string;
  side: MeteoraLimitOrderSide;
  binIds: number[];
  maxBinsPerOrder: number;
  quote: MeteoraLimitOrderInfrastructureQuote;
  requiredBinArrays: MeteoraBinArrayPreflight[];
  missingBinArrays: Array<{ index: number; address: string }>;
  bitmapExtensionRequired: boolean;
  bitmapExtensionAddress: string | null;
  bitmapExtensionInitialized: boolean | null;
  sharedInfrastructureAuthorized: boolean;
  safeWithoutSharedInfrastructureFunding: boolean;
  /** Read-only target-bin observations; never used as a hidden execution gate. */
  bins: MeteoraLimitOrderGeometryBin[];
  oppositeSideLiquidityBinIds: number[];
  oppositeSideLiquidityKnown: boolean;
  safeToBuild: boolean;
  warnings: string[];
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
  geometry?: MeteoraLimitOrderGeometryPreflight;
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

export type MeteoraLimitOrderBatchOrder = {
  id: string;
  side: MeteoraLimitOrderSide;
  bins: MeteoraLimitOrderBinInput[];
  infrastructure?: MeteoraInfrastructureFundingPolicy;
};

export type MeteoraLimitOrderBatchPreflightArgs = {
  wallet: WalletRef;
  pool: string;
  orders: MeteoraLimitOrderBatchOrder[];
  infrastructure?: MeteoraInfrastructureFundingPolicy;
  nativeReserveLamports?: MeteoraInteger;
  commitment?: Commitment;
};

export type MeteoraLimitOrderBatchPreflightOrder = {
  id: string;
  side: MeteoraLimitOrderSide;
  inputMint: string;
  totalInputRaw: string;
  binIds: number[];
  executable: boolean;
  errorCode: MeteoraErrorCode | null;
  errorMessage: string | null;
  geometry: MeteoraLimitOrderGeometryPreflight | null;
  transactionCount: number | null;
  requiredSignerPubkeys: string[];
  requiredSigners: Array<{
    pubkey: string;
    role: "wallet" | "generated-limit-order" | "unknown";
  }>;
  missingRequiredSignerPubkeys: string[];
  estimatedNetworkFeeLamports: string | null;
  networkFeeEstimateComplete: boolean;
  limitOrderRentLamports: string | null;
  nonRefundableInfrastructureLamports: string;
};

export type MeteoraLimitOrderBatchPreflight = {
  version: 1;
  observedAt: number;
  wallet: string;
  pool: string;
  safeToBuild: boolean;
  inputFundingSufficient: boolean;
  nativeFundingSufficient: boolean | null;
  safeToExecute: boolean;
  balances: MeteoraWalletPoolBalances;
  nativeReserveLamports: string;
  orders: MeteoraLimitOrderBatchPreflightOrder[];
  total: {
    executableOrders: number;
    rejectedOrders: number;
    allOrdersExecutable: boolean;
    requestedInputXRaw: string;
    requestedInputYRaw: string;
    requestedWsolInputLamports: string;
    limitOrderRentLamports: string | null;
    nonRefundableInfrastructureLamports: string;
    estimatedNetworkFeeLamports: string | null;
    networkFeeEstimateComplete: boolean;
    requiredNativeLamports: string | null;
    tokenXFundingSufficient: boolean;
    tokenYFundingSufficient: boolean;
  };
};

export type MeteoraPlaceLimitOrderBatchArgs =
  MeteoraLimitOrderBatchPreflightArgs & {
    /**
     * If a later placement fails, try to cancel already-placed siblings.
     * Defaults to false so rollback is never a hidden financial side effect.
     */
    rollbackOnPartialFailure?: boolean;
  };

export type MeteoraLimitOrderBatchPlacement = {
  id: string;
  side: MeteoraLimitOrderSide;
  binIds: number[];
  limitOrder: string | null;
  result: MeteoraExecutionResult | null;
  errorCode: MeteoraErrorCode | null;
  errorMessage: string | null;
};

export type MeteoraLimitOrderBatchRollback = {
  id: string;
  limitOrder: string;
  ok: boolean;
  result: MeteoraExecutionResult | null;
  errorCode: MeteoraErrorCode | null;
  errorMessage: string | null;
};

export type MeteoraLimitOrderBatchExecutionResult = {
  version: 1;
  wallet: string;
  pool: string;
  complete: boolean;
  partial: boolean;
  rollbackRequested: boolean;
  rollbackComplete: boolean | null;
  preflight: MeteoraLimitOrderBatchPreflight;
  placements: MeteoraLimitOrderBatchPlacement[];
  rollbacks: MeteoraLimitOrderBatchRollback[];
};

export type MeteoraLimitOrderStatus =
  "not-filled" | "partial-filled" | "fulfilled" | "unknown";

export type MeteoraLimitOrderBinSnapshot = {
  binId: number;
  empty: boolean;
  status: MeteoraLimitOrderStatus;
  /** Original deposited input amount for this bin, when exposed by upstream. */
  depositedInputRaw: string | null;
  /** Input still resting/unfilled in this bin, when exposed by upstream. */
  remainingInputRaw: string | null;
  /** Input consumed by fills in this bin, when derivable or exposed upstream. */
  filledInputRaw: string | null;
  withdrawableXRaw: string | null;
  withdrawableYRaw: string | null;
  feeXRaw: string | null;
  feeYRaw: string | null;
  raw: Record<string, unknown>;
};

export type MeteoraLimitOrderSettlementSummary = {
  binCount: number;
  openBinCount: number;
  notFilledBinCount: number;
  partiallyFilledBinCount: number;
  fulfilledBinCount: number;
  unknownStatusBinCount: number;
  minBinId: number | null;
  maxBinId: number | null;
  depositedInputRaw: string | null;
  remainingInputRaw: string | null;
  filledInputRaw: string | null;
  fillPct: number | null;
  filledBinPct: number | null;
  withdrawableXRaw: string | null;
  withdrawableYRaw: string | null;
  feeXRaw: string | null;
  feeYRaw: string | null;
  weightedAverageFillBin: number | null;
  amountsComplete: boolean;
  fullyFilled: boolean;
  /** True only when the order account itself no longer exists. */
  fullySettled: boolean;
};

export type MeteoraLimitOrderSnapshot = {
  version: 1;
  observedAt: number;
  /** Pool used to resolve/query this order. */
  pool: string;
  /** Pool recorded in the limit-order account/parser, when exposed upstream. */
  accountPool: string | null;
  limitOrder: string;
  exists: boolean;
  owner: string | null;
  side: MeteoraLimitOrderSide | null;
  tokenX: MeteoraPoolToken;
  tokenY: MeteoraPoolToken;
  bins: MeteoraLimitOrderBinSnapshot[];
  openBinIds: number[];
  summary: MeteoraLimitOrderSettlementSummary;
  raw: Record<string, unknown> | null;
};

export type MeteoraManagedLimitOrderRecord = {
  version: 1;
  limitOrder: string;
  pool: string;
  owner: string;
  side: MeteoraLimitOrderSide;
  createdSignature: string;
  createdAt: number;
};

export type MeteoraManagedLimitOrderVerification = {
  version: 1;
  checkedAt: number;
  ok: boolean;
  record: MeteoraManagedLimitOrderRecord;
  actual: MeteoraLimitOrderSnapshot | null;
  checks: {
    accountExists: boolean;
    poolMatches: boolean | null;
    ownerMatches: boolean | null;
    sideMatches: boolean | null;
  };
  errors: string[];
  warnings: string[];
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
  | MeteoraPositionVerification
  | MeteoraLimitOrderVerification
  | MeteoraPoolPriceSyncVerification;

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
    | "close-limit-order"
    | "sync-pool-price";
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
  /**
   * Position-local funded-bin proof derived from the SDK's positionBinData.
   * This is stronger than lowerBin/upperBin: a position may declare a wide
   * range while only a subset of those bins actually carries liquidity.
   */
  liquidityCoverage?: {
    /** True when the SDK exposed enough per-bin data to prove or disprove full funding. */
    observable: boolean;
    /** lowerBin..upperBin width when both bounds are known. */
    expectedBinCount: number | null;
    /** Raw number of SDK positionBinData rows observed. */
    positionBinDataCount: number;
    /** Unique rows whose bin id and liquidity amount could both be decoded. */
    mappedBinCount: number;
    /** Rows whose bin id or liquidity amount could not be decoded safely. */
    unreadableBinCount: number;
    /** Bin ids carrying strictly positive position liquidity. */
    fundedBinIds: number[];
    /** Mapped bin ids explicitly reporting zero position liquidity. */
    zeroLiquidityBinIds: number[];
    /** Expected range bins not proven to carry positive position liquidity. */
    missingFundedBinIds: number[];
    /**
     * true: every declared bin is proven funded; false: at least one declared
     * bin is proven/unambiguously missing; null: installed SDK data is insufficient.
     */
    fullRangeFunded: boolean | null;
  };
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
  /** Canonical selector contract. */
  candidates: MeteoraPoolDiscoveryCandidateV1[];
  /** @deprecated Use candidates. Retained for backward compatibility. */
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
  /**
   * When true, swap only recovered source-position inventory as needed to fit
   * the target strategy/range before reopening. Fresh wallet principal remains
   * excluded. Defaults to false for backwards compatibility.
   */
  balanceInventory?: boolean;
  nativeReserveLamports?: MeteoraInteger;
};

export type MeteoraMoveCapitalAttribution = {
  sourcePosition: string;
  principalSource: "source-position-only";
  /** Source position inventory + unclaimed fees immediately before close. */
  sourceAttributableXRaw: string;
  sourceAttributableYRaw: string;
  /** Positive wallet deltas attributable to the source close, before source-cap clipping.
   * For a WSOL side, Solard may conservatively map a positive native-SOL delta
   * back to that side when no SPL WSOL delta is observable.
   */
  observedRecoveredXRaw: string;
  observedRecoveredYRaw: string;
  /** Positive native-SOL wallet delta observed across the source close. */
  observedRecoveredNativeLamports: string;
  /** WSOL side that used native-SOL recovery evidence, when applicable. */
  nativeRecoveryAppliedTo: "x" | "y" | null;
  /** Amounts eligible to become new LP principal: min(observed close delta, source attributable cap). */
  eligibleReopenXRaw: string;
  eligibleReopenYRaw: string;
  /** Amounts requested for the replacement position. */
  reopenedXRaw: string;
  reopenedYRaw: string;
  freshWalletPrincipalXRaw: "0";
  freshWalletPrincipalYRaw: "0";
  /** True only when source-attributable WSOL proceeds were observed as native SOL.
   * Fresh wallet SOL is still excluded by source-attributable clipping.
   */
  nativeSolUsedAsPrincipal: boolean;
  marketSwapPerformed: boolean;
  marketSwapDirection: "x-to-y" | "y-to-x" | null;
  marketSwapInputRaw: string;
  marketSwapOutputRaw: string;
  marketSwapSignatures: string[];
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
