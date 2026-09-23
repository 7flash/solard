import type {
  ConfirmedSignatureInfo,
  ParsedTransactionWithMeta,
} from "@solana/web3.js";

export type TokenHistoryVenue = "pump-curve" | "pumpswap" | "raydium";
export type TokenHistorySide = "buy" | "sell";
export type TokenHistoryScanKind = "curve" | "pool";
export type TokenHistoryCommitment = "confirmed" | "finalized";
export type TokenHistoryConfidence =
  "processed" | "confirmed" | "finalized" | "dropped";

export type PumpSwapFeeBreakdown = {
  source: "anchor-event";
  eventCount: number;
  quoteMint: string;
  userQuoteAmountRaw: string;
  lpFeeQuoteRaw: string;
  protocolFeeQuoteRaw: string;
  creatorFeeQuoteRaw: string | null;
  cashbackQuoteRaw: string | null;
  buybackFeeQuoteRaw: string | null;
  holderRewardsQuoteRaw: string | null;
};

export type TokenHistoryRaw = {
  parserVersion: string;
  venue: TokenHistoryVenue;
  instructionKinds: string[];
  instructionIndex: number;
  historyOrder: number;
  scanAddress: string;
  scanKind: TokenHistoryScanKind;
  ownerTokenDeltaRaw: string;
  nativeWalletDeltaLamports: string | null;
  networkFeeLamports: string;
  tokenAccountRentDeltaLamports: string;
  wsolDeltaRaw: string;
  economicQuoteDeltaLamports: string | null;
  pricingStatus:
    "native-wsol-corrected" | "instruction-input-fallback" | "missing";
  excludedExternalTransfersLamports: string;
  marketCapSol: number | null;
  pumpSwapFees?: PumpSwapFeeBreakdown;
};

/**
 * Durable research-domain trade. Deliberately independent from db.ts so the
 * parser/backtester can be imported in fixture tests without initializing DB.
 */
export type TokenHistoryTrade = {
  eventKey: string;
  mint: string;
  signature: string;
  slot: number;
  owner: string | null;
  side: TokenHistorySide;
  tokenDeltaUi: number;
  solDeltaUi: number;
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  confidence: TokenHistoryConfidence;
  source: string;
  rawJson: string;
  tradedAtMs: number;
  updatedAtMs: number;
  history: TokenHistoryRaw;
};

export type TokenHistoryCandle1s = {
  candleKey: string;
  mint: string;
  bucketAtMs: number;
  openPriceSol: number;
  highPriceSol: number;
  lowPriceSol: number;
  closePriceSol: number;
  volumeSol: number;
  volumeToken: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  buys: number;
  sells: number;
  trades: number;
  firstSignature: string;
  lastSignature: string;
  firstSlot: number;
  lastSlot: number;
  updatedAtMs: number;
};

export type AddressHistoryCoverage = {
  kind: TokenHistoryScanKind;
  address: string;
  pages: number;
  signatures: number;
  oldestSignature: string | null;
  oldestSlot: number | null;
  oldestBlockTime: number | null;
  newestSignature: string | null;
  newestSlot: number | null;
  newestBlockTime: number | null;
  reachedStart: boolean;
  truncated: boolean;
};

export type TokenHistoryCoverage = {
  version: 1;
  /** Optional venue family. Omitted by historical Pump coverage rows. */
  venueFamily?: "pump" | "raydium";
  mint: string;
  quoteMint: string;
  decimals: number;
  supplyRaw: string;
  supplyUi: number;
  bondingCurve: string;
  pool: string | null;
  commitment: TokenHistoryCommitment;
  curve: AddressHistoryCoverage;
  pumpswap: AddressHistoryCoverage | null;
  /** All scanned market addresses for multi-pool Raydium history. */
  scanAddresses?: AddressHistoryCoverage[];
  launchLabPool?: string | null;
  raydiumPools?: string[];
  uniqueSignatures: number;
  parsedTransactions: number;
  missingTransactions: number;
  failedTransactions: number;
  skippedNoTimestamp: number;
  skippedAmbiguous: number;
  storedTrades: number;
  storedCandles1s: number;
  insertedTrades: number;
  updatedTrades: number;
  creationSignature: string | null;
  creationAtMs: number | null;
  creationSlot: number | null;
  creationName: string | null;
  creationSymbol: string | null;
  fromCreation: boolean;
  complete: boolean;
  historyMode?: "exact" | "price-sampled";
  priceSampleMs?: number | null;
  sampledSignatures?: number;
  priceTapeComplete?: boolean;
  updatedAtMs: number;
};

export type TokenHistoryBackfillProgress =
  | {
      phase: "signatures";
      kind: TokenHistoryScanKind;
      address: string;
      pages: number;
      signatures: number;
    }
  | {
      phase: "sample";
      total: number;
      selected: number;
      sampleMs: number;
    }
  | {
      phase: "transactions";
      completed: number;
      total: number;
      batchSize: number;
    }
  | {
      phase: "retry";
      operation: "signatures" | "transactions";
      attempt: number;
      maxAttempts: number;
      error: string;
      kind?: TokenHistoryScanKind;
    }
  | {
      phase: "rpc-error";
      operation: "signatures" | "transactions";
      error: string;
      failedItems: number;
      kind?: TokenHistoryScanKind;
    }
  | {
      phase: "throttle";
      operation: "transactions";
      reason: "rate-limit" | "batch-pressure";
      waitMs: number;
      batchSize: number;
      nextBatchSize: number;
    }
  | {
      phase: "parse";
      completed: number;
      total: number;
      trades: number;
      ambiguous: number;
    }
  | {
      phase: "store";
      completed: number;
      total: number;
      inserted: number;
      updated: number;
    }
  | {
      phase: "candles";
      trades: number;
      candles: number;
    };

export type BackfillTokenHistoryOptions = {
  commitment?: TokenHistoryCommitment;
  pageSize?: number;
  transactionBatchSize?: number;
  transactionConcurrency?: number;
  rpcTimeoutMs?: number;
  rpcRetries?: number;
  retryDelayMs?: number;
  maxSignaturesPerAddress?: number;
  priceSampleMs?: number;
  replace?: boolean;
  onProgress?: (progress: TokenHistoryBackfillProgress) => void;
};

export type NormalizedTokenHistoryRpcOptions = {
  commitment: TokenHistoryCommitment;
  pageSize: number;
  transactionBatchSize: number;
  transactionConcurrency: number;
  rpcTimeoutMs: number;
  rpcRetries: number;
  retryDelayMs: number;
  maxSignaturesPerAddress: number;
  onProgress?: BackfillTokenHistoryOptions["onProgress"];
};

export type TokenHistoryAnalysis = {
  mint: string;
  coverage: TokenHistoryCoverage | null;
  trades: number;
  buys: number;
  sells: number;
  uniqueTraders: number;
  buySol: number;
  sellSol: number;
  netInflowSol: number;
  firstTradeAtMs: number | null;
  lastTradeAtMs: number | null;
  firstExternalBuyer: TokenHistoryTrade | null;
  athPriceSol: number | null;
  atlPriceSol: number | null;
  athMarketCapSol: number | null;
  atlMarketCapSol: number | null;
  roundTripTraders: number;
  owners: Array<{
    owner: string;
    buySol: number;
    sellSol: number;
    netSpentSol: number;
    boughtTokens: number;
    soldTokens: number;
    netTokens: number;
    buys: number;
    sells: number;
    trades: number;
    firstTradeAtMs: number;
    lastTradeAtMs: number;
  }>;
};

export type TokenHistoryScanSignature = ConfirmedSignatureInfo & {
  scanKind: TokenHistoryScanKind;
  scanAddress: string;
  localChronologicalOrder: number;
};

export type TokenHistoryScanResult = {
  rows: TokenHistoryScanSignature[];
  coverage: AddressHistoryCoverage;
};

export type TokenHistoryTransactionFetchResult = {
  bySignature: Map<string, ParsedTransactionWithMeta>;
  missingTransactions: number;
  failedTransactions: number;
};

export type TokenHistoryClock = {
  nowMs(): number;
};

export type TokenHistoryForensicsOptions = {
  firstBuyerLimit?: number;
  topLimit?: number;
};

export type TokenHistoryOwnerPnl = {
  owner: string;
  buys: number;
  sells: number;
  buySol: number;
  sellSol: number;
  boughtTokens: number;
  soldTokens: number;
  realizedCostSol: number;
  realizedProceedsSol: number;
  realizedPnlSol: number;
  remainingTokens: number;
  remainingCostSol: number;
  markPriceSol: number | null;
  markedValueSol: number;
  unrealizedPnlSol: number;
  totalPnlSol: number;
  networkFeesSol: number;
  externalTransfersSol: number;
  recordedExecutionCostsSol: number;
  netPnlAfterRecordedCostsSol: number;
  unmatchedSoldTokens: number;
  unmatchedSellProceedsSol: number;
  costBasisComplete: boolean;
  roiPct: number | null;
  firstBuyAtMs: number | null;
  lastSellAtMs: number | null;
};

export type TokenHistoryFirstBuyer = {
  trade: TokenHistoryTrade;
  buyRank: number;
  uniqueBuyerRank: number;
  owned: boolean;
  creationDeltaMs: number | null;
  firstBuyDeltaMs: number | null;
  slotDeltaFromFirstBuy: number | null;
};

export type TokenHistoryOwnedEntry = {
  owner: string;
  trade: TokenHistoryTrade;
  buyRank: number;
  uniqueBuyerRank: number | null;
  buyersAhead: number;
  uniqueBuyersAhead: number;
  buySolAhead: number;
  externalBuysAhead: number;
  externalUniqueBuyersAhead: number;
  externalBuySolAhead: number;
  sameTimestampBuysAhead: number;
  sameSlotBuysAhead: number;
  creationDeltaMs: number | null;
  firstBuyDeltaMs: number | null;
  firstExternalBuyDeltaMs: number | null;
  slotDeltaFromFirstBuy: number | null;
  slotDeltaFromFirstExternalBuy: number | null;
};

export type TokenHistoryPeriodSummary = {
  id: string;
  label: string;
  startMs: number;
  endMs: number | null;
  trades: number;
  buys: number;
  sells: number;
  buySol: number;
  sellSol: number;
  netFlowSol: number;
  ownedTrades: number;
  ownedBuySol: number;
  ownedSellSol: number;
  ownedRealizedPnlSol: number;
  ownedRecordedExecutionCostsSol: number;
  ownedNetRealizedAfterRecordedCostsSol: number;
};

export type TokenHistoryForensics = {
  mint: string;
  coverage: TokenHistoryCoverage | null;
  markPriceSol: number | null;
  firstMarketBuy: TokenHistoryTrade | null;
  firstExternalBuy: TokenHistoryTrade | null;
  firstBuyers: TokenHistoryFirstBuyer[];
  ownedEntries: TokenHistoryOwnedEntry[];
  ownerPnl: TokenHistoryOwnerPnl[];
  ownedPnl: TokenHistoryOwnerPnl[];
  ownedTotal: {
    wallets: number;
    buySol: number;
    sellSol: number;
    realizedPnlSol: number;
    unrealizedPnlSol: number;
    totalPnlSol: number;
    networkFeesSol: number;
    externalTransfersSol: number;
    recordedExecutionCostsSol: number;
    netPnlAfterRecordedCostsSol: number;
    remainingTokens: number;
    incompleteWallets: number;
  };
  topRealizedWinners: TokenHistoryOwnerPnl[];
  topTotalWinners: TokenHistoryOwnerPnl[];
  topTotalLosers: TokenHistoryOwnerPnl[];
  periods: TokenHistoryPeriodSummary[];
};
