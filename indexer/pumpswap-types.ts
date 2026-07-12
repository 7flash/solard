export type PumpSwapCounters = {
  sessions: number;
  messages: number;

  transactionNotifications: number;
  logNotifications: number;
  fetchedTransactions: number;

  swapsSeen: number;
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

  solUsd: number | null;
  solUsdAtMs: number | null;

  mode: "transactionSubscribe" | "logsSubscribe";
};

export type PumpSwapCandidate = {
  signature: string;
  slot: number;
  tradedAtMs: number;

  pool: string;
  owner: string | null;

  baseMint: string;
  quoteMint: string;

  side: "buy" | "sell";

  baseAmountUi: number;
  quoteAmountUi: number;

  instruction: "buy" | "buy_exact_quote_in" | "sell";

  confidence: "processed" | "confirmed" | "finalized";
};
