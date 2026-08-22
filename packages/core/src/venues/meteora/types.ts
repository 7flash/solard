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
