export type PumpSwapCounters = {
  cycles: number;
  trackedTokens: number;
  trackedPools: number;

  discoveryRequests: number;
  discoveryTransactions: number;
  poolsDiscovered: number;
  discoveryMisses: number;

  websocketConnections: number;
  websocketConnecting: number;
  subscriptions: number;
  pendingSubscriptions: number;
  subscribeRequests: number;
  subscriptionErrors: number;
  unsubscriptions: number;
  reconnects: number;
  notifications: number;
  wsBytes: number;
  dirtyTokens: number;

  accountBatches: number;
  accountsRequested: number;
  priceUpdates: number;
  invalidReserves: number;

  lifecycleEvictions: number;
  inactiveEvictions: number;
  interestEvictions: number;
  raydiumEvictions: number;
  capacityEvictions: number;

  historyRequests: number;
  historyTransactions: number;
  trades: number;
  duplicateTrades: number;

  unknownMints: number;
  nonCanonicalPools: number;
  unsupportedQuotes: number;
  ambiguousSwaps: number;
  skipped: number;
  errors: number;

  lastSignature: string | null;
  lastMint: string | null;
  lastTradeAtMs: number | null;
  lastPriceAtMs: number | null;

  solUsd: number | null;
  solUsdAtMs: number | null;

  mode: "tracked-account-subscriptions";
};

export type PumpSwapCandidate = {
  signature: string;
  slot: number;
  tradedAtMs: number;

  pool: string;
  owner: string | null;

  baseMint: string;
  quoteMint: string;
  poolBaseTokenAccount: string;
  poolQuoteTokenAccount: string;

  side: "buy" | "sell";

  baseAmountUi: number;
  quoteAmountUi: number;

  instruction: "buy" | "buy_exact_quote_in" | "sell";

  confidence: "processed" | "confirmed" | "finalized";
};

export type TrackedMigratedToken = {
  mint: string;
  supplyUi: number;
  migrationSlot: number;
  observedAtMs: number;
  updatedAtMs: number;
  activityAtMs: number;
  interestAtMs: number;
  interestScore: number;
  venue: string | null;
};

export type PumpSwapPoolState = {
  mint: string;
  supplyUi: number;
  migrationSlot: number;

  pool: string | null;
  quoteMint: string | null;
  poolBaseTokenAccount: string | null;
  poolQuoteTokenAccount: string | null;

  lastHistorySlot: number;
  lastSignature: string | null;
  discoveredAtMs: number | null;
  lastPriceAtMs: number | null;
  lastHistoryAtMs: number | null;
  lastActivityAtMs: number | null;
  lastInterestAtMs: number | null;
  interestScore: number;

  discoveryAttempts: number;
  nextDiscoveryAtMs: number;
  lastError: string | null;
};

export type PumpSwapReserveSample = {
  state: PumpSwapPoolState;
  slot: number;
  baseRaw: bigint;
  quoteRaw: bigint;
  priceSol: number | null;
  priceUsd: number | null;
  marketCapSol: number | null;
  marketCapUsd: number | null;
  sampledAtMs: number;
};
