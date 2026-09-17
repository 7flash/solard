import { Database, z } from "sqlite-zod-orm";

export const WalletSchema = z.object({
  name: z.string(),
  address: z.string(),
  encryptedSecretKey: z.string(),
  nonce: z.string(),
  authTag: z.string(),
  isActive: z.number().default(1),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const TokenSchema = z.object({
  mint: z.string(),
  name: z.string().nullable().default(null),
  symbol: z.string().nullable().default(null),
  decimals: z.number().nullable().default(null),
  createKind: z.enum(["unknown", "create", "create_v2"]).default("unknown"),
  creator: z.string().nullable().default(null),
  quoteMint: z.string().nullable().default(null),
  quoteTokenProgram: z.string().nullable().default(null),
  baseTokenProgram: z.string().nullable().default(null),
  bondingCurve: z.string().nullable().default(null),
  pool: z.string().nullable().default(null),
  sharingConfig: z.string().nullable().default(null),
  venueHint: z.enum(["unknown", "pump-curve", "pumpswap"]).default("unknown"),
  metadataJson: z.string().nullable().default(null),
  refreshedAtMs: z.number().nullable().default(null),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const ExecutionSchema = z.object({
  signature: z.string().nullable().default(null),
  kind: z.string(),
  status: z.enum(["planned", "simulated", "submitted", "confirmed", "failed"]),
  walletAddress: z.string(),
  mint: z.string().nullable().default(null),
  sender: z.string().nullable().default(null),
  venue: z.string().nullable().default(null),
  slot: z.number().nullable().default(null),
  error: z.string().nullable().default(null),
  metaJson: z.string().nullable().default(null),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const ExecutionActionSchema = z.object({
  executionId: z.number(),
  actionIndex: z.number(),
  kind: z.string(),
  mint: z.string().nullable().default(null),
  recipient: z.string().nullable().default(null),
  metadataJson: z.string(),
  createdAtMs: z.number(),
});

export const PositionSchema = z.object({
  walletAddress: z.string(),
  mint: z.string(),
  tokenAmountRaw: z.string(),
  avgEntryQuoteRaw: z.string().nullable().default(null),
  avgExitQuoteRaw: z.string().nullable().default(null),
  realizedPnlQuoteRaw: z.string().nullable().default(null),
  quoteMint: z.string().nullable().default(null),
  updatedAtMs: z.number(),
});

export const BalanceSchema = z.object({
  walletAddress: z.string(),
  mint: z.string(),
  amountRaw: z.string(),
  decimals: z.number().nullable().default(null),
  capturedAtMs: z.number(),
});

/** Venue-observed market price samples used by the SDK's price/watch APIs. */
export const TokenHistoryTradeSchema = z.object({
  eventKey: z.string(),
  mint: z.string(),
  signature: z.string(),
  slot: z.number().default(0),
  owner: z.string().nullable().default(null),
  side: z.enum(["buy", "sell", "unknown"]).default("unknown"),
  tokenDeltaUi: z.number().default(0),
  solDeltaUi: z.number().default(0),
  priceSol: z.number().nullable().default(null),
  priceUsd: z.number().nullable().default(null),
  marketCapUsd: z.number().nullable().default(null),
  confidence: z
    .enum(["processed", "confirmed", "finalized", "dropped"])
    .default("processed"),
  source: z.string().default("unknown"),
  rawJson: z.string().default("{}"),
  tradedAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const TokenHistoryCandle1sSchema = z.object({
  candleKey: z.string(),
  mint: z.string(),
  bucketAtMs: z.number(),
  openPriceSol: z.number(),
  highPriceSol: z.number(),
  lowPriceSol: z.number(),
  closePriceSol: z.number(),
  volumeSol: z.number().default(0),
  volumeToken: z.number().default(0),
  buyVolumeSol: z.number().default(0),
  sellVolumeSol: z.number().default(0),
  buys: z.number().default(0),
  sells: z.number().default(0),
  trades: z.number().default(0),
  firstSignature: z.string(),
  lastSignature: z.string(),
  firstSlot: z.number().default(0),
  lastSlot: z.number().default(0),
  updatedAtMs: z.number(),
});

export const PriceSampleSchema = z.object({
  mint: z.string(),
  venue: z.string(),
  quoteMint: z.string(),
  quoteKind: z.enum(["native-sol", "spl-token"]),
  priceQuotePerToken: z.number(),
  baseReserveRaw: z.string().nullable().default(null),
  quoteReserveRaw: z.string().nullable().default(null),
  capturedAtMs: z.number(),
});

export const ClaimSchema = z.object({
  walletAddress: z.string(),
  mint: z.string(),
  quoteMint: z.string(),
  path: z.string(),
  estimatedClaimRaw: z.string(),
  claimedRaw: z.string().nullable().default(null),
  signature: z.string().nullable().default(null),
  status: z.enum(["planned", "submitted", "confirmed", "failed"]),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const GroupSchema = z.object({
  name: z.string(),
  description: z.string().nullable().default(null),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const GroupWalletSchema = z.object({
  groupName: z.string(),
  walletAddress: z.string(),
  weightBps: z.number().default(10000),
  createdAtMs: z.number(),
});

export const AgentSchema = z.object({
  name: z.string(),
  configJson: z.string(),
  stateJson: z.string(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const AltSchema = z.object({
  address: z.string(),
  label: z.string().nullable().default(null),
  isActive: z.number().default(1),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const WatchSchema = z.object({
  kind: z.enum(["token", "wallet", "program"]),
  address: z.string(),
  label: z.string().nullable().default(null),
  configJson: z.string().nullable().default(null),
  isActive: z.number().default(1),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const RawTransactionSchema = z.object({
  signature: z.string(),
  slot: z.number(),
  blockTimeMs: z.number().nullable().default(null),
  confidence: z.enum(["confirmed", "finalized"]),
  transactionJson: z.string(),
  fetchedAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const HistoryDiscoverySchema = z.object({
  discoveryKey: z.string(),
  scope: z.string(),
  signature: z.string(),
  slot: z.number(),
  errJson: z.string().nullable().default(null),
  blockTimeMs: z.number().nullable().default(null),
  confirmationStatus: z.string().nullable().default(null),
  discoveredAtMs: z.number(),
});

export const HistoryBlockSchema = z.object({
  slot: z.number(),
  signaturesJson: z.string(),
  fetchedAtMs: z.number(),
});

export const HistoryTokenAccountSchema = z.object({
  accountKey: z.string(),
  mint: z.string(),
  address: z.string(),
  initializedAtSlot: z.number().nullable().default(null),
  initializedBySignature: z.string().nullable().default(null),
  incarnationsJson: z.string().default("[]"),
  discoveredAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const HistoryReplayItemSchema = z.object({
  replayKey: z.string(),
  mint: z.string(),
  signature: z.string(),
  slot: z.number(),
  timestampSec: z.number().nullable().default(null),
  transactionIndex: z.number().nullable().default(null),
  instructionIndex: z.number().nullable().default(null),
  innerInstructionIndex: z.number().nullable().default(null),
  kind: z.string(),
  trxJson: z.string(),
  beforeBalanceRaw: z.string().nullable().default(null),
  postBalanceRaw: z.string().nullable().default(null),
  payoutsJson: z.string().default("[]"),
  quoteMint: z.string().nullable().default(null),
  claimAttribution: z
    .enum(["exact-token", "creator-aggregate-ambiguous"])
    .nullable()
    .default(null),
  parserVersion: z.string(),
  observedAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const HistoryReplayCoverageSchema = z.object({
  mint: z.string(),
  parserVersion: z.string(),
  recipient: z.string().nullable().default(null),
  originalCreator: z.string().nullable().default(null),
  creationSlot: z.number().nullable().default(null),
  finalizedThroughSlot: z.number(),
  attemptedThroughSlot: z.number().default(0),
  authoritative: z.number().default(0),
  tokenBalancesAuthoritative: z.number().default(0),
  creatorRewardsAuthoritative: z.number().default(0),
  complete: z.number().default(0),
  warningsJson: z.string().default("[]"),
  updatedAtMs: z.number(),
});

export const SettingSchema = z.object({
  key: z.string(),
  value: z.string(),
  updatedAtMs: z.number(),
});

export type WalletRow = z.infer<typeof WalletSchema> & { id: number };
export type TokenRow = z.infer<typeof TokenSchema> & { id: number };
export type ExecutionRow = z.infer<typeof ExecutionSchema> & { id: number };
export type ExecutionActionRow = z.infer<typeof ExecutionActionSchema> & {
  id: number;
};
export type PositionRow = z.infer<typeof PositionSchema> & { id: number };
export type BalanceRow = z.infer<typeof BalanceSchema> & { id: number };
export type TokenHistoryTradeRow = z.infer<typeof TokenHistoryTradeSchema> & {
  id: number;
};
export type TokenHistoryCandle1sRow = z.infer<
  typeof TokenHistoryCandle1sSchema
> & { id: number };
export type PriceSampleRow = z.infer<typeof PriceSampleSchema> & { id: number };
export type ClaimRow = z.infer<typeof ClaimSchema> & { id: number };
export type GroupRow = z.infer<typeof GroupSchema> & { id: number };
export type GroupWalletRow = z.infer<typeof GroupWalletSchema> & { id: number };
export type AgentRow = z.infer<typeof AgentSchema> & { id: number };
export type AltRow = z.infer<typeof AltSchema> & { id: number };
export type WatchRow = z.infer<typeof WatchSchema> & { id: number };
export type RawTransactionRow = z.infer<typeof RawTransactionSchema> & {
  id: number;
};
export type HistoryDiscoveryRow = z.infer<typeof HistoryDiscoverySchema> & {
  id: number;
};
export type HistoryBlockRow = z.infer<typeof HistoryBlockSchema> & {
  id: number;
};
export type HistoryTokenAccountRow = z.infer<
  typeof HistoryTokenAccountSchema
> & { id: number };
export type HistoryReplayItemRow = z.infer<typeof HistoryReplayItemSchema> & {
  id: number;
};
export type HistoryReplayCoverageRow = z.infer<
  typeof HistoryReplayCoverageSchema
> & { id: number };
export type SettingRow = z.infer<typeof SettingSchema> & { id: number };

export type SolardDatabase = Database<{
  wallets: typeof WalletSchema;
  tokens: typeof TokenSchema;
  executions: typeof ExecutionSchema;
  executionActions: typeof ExecutionActionSchema;
  positions: typeof PositionSchema;
  balances: typeof BalanceSchema;
  priceSamples: typeof PriceSampleSchema;
  tokenHistoryTradesV1: typeof TokenHistoryTradeSchema;
  tokenHistoryCandles1sV1: typeof TokenHistoryCandle1sSchema;
  claims: typeof ClaimSchema;
  groups: typeof GroupSchema;
  groupWallets: typeof GroupWalletSchema;
  agents: typeof AgentSchema;
  alts: typeof AltSchema;
  watches: typeof WatchSchema;
  rawTransactions: typeof RawTransactionSchema;
  historyDiscovery: typeof HistoryDiscoverySchema;
  historyBlocks: typeof HistoryBlockSchema;
  historyTokenAccounts: typeof HistoryTokenAccountSchema;
  historyReplayItems: typeof HistoryReplayItemSchema;
  historyReplayCoverage: typeof HistoryReplayCoverageSchema;
  settings: typeof SettingSchema;
}>;
