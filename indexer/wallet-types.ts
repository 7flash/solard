export type WalletConfidence =
  "processed" | "confirmed" | "finalized" | "dropped";

export type WalletSwapSide = "buy" | "sell" | "swap" | "unknown";

export type WalletSwapCandidate = {
  eventKey: string;
  wallet: string;
  signature: string;
  slot: number;

  inputMint: string;
  inputAmountUi: number;
  outputMint: string;
  outputAmountUi: number;

  subjectMint: string;
  quoteMint: string | null;
  side: WalletSwapSide;

  venue: string;
  programId: string | null;
  parser: string;
  classificationConfidence: "exact" | "inferred" | "ambiguous";
  copyable: boolean;

  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;

  tradedAtMs: number;
  raw: unknown;
};

export type ParsedWalletTransaction = {
  signature: string;
  slot: number;
  tradedAtMs: number;
  confidence: WalletConfidence;
  wallets: string[];
  swaps: WalletSwapCandidate[];
  raw: unknown;
};

export type WalletIndexerCounters = {
  websocketConnections: number;
  websocketConnecting: number;
  subscriptionRequests: number;
  subscriptions: number;
  unsubscriptions: number;
  subscriptionErrors: number;
  reconnects: number;
  notifications: number;
  wsBytes: number;

  walletRefreshes: number;
  enabledWallets: number;

  backfillCycles: number;
  backfillWallets: number;
  backfillSignatures: number;
  backfillTransactions: number;
  backfillErrors: number;

  parsedTransactions: number;
  ignoredTransactions: number;
  parsedSwaps: number;
  duplicateSwaps: number;
  pumpSwaps: number;
  pumpCurveSwaps: number;
  inferredSwaps: number;

  errors: number;
  lastWallet: string | null;
  lastSignature: string | null;
  lastSwapAtMs: number | null;

  solUsd: number | null;
  solUsdAtMs: number | null;
};
