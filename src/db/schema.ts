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
  status: z.enum(["planned", "simulated", "broadcast", "confirmed", "failed"]),
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

/** Venue-observed market price sample for watch/SMA tooling. This is analytics
 * data, never the source of truth for transaction slippage checks. */
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
  status: z.enum(["planned", "broadcast", "confirmed", "failed"]),
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

export const SettingSchema = z.object({
  key: z.string(),
  value: z.string(),
  updatedAtMs: z.number(),
});

export const TokenWatchGroupSchema = z.object({
  groupId: z.string(),
  name: z.string(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const TokenWatchGroupTokenSchema = z.object({
  groupId: z.string(),
  mint: z.string(),
  addedAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const PumpTokenEventSchema = z.object({
  mint: z.string(),
  signature: z.string().nullable().default(null),
  source: z.string(),
  eventType: z
    .enum(["create", "trade", "curve-poll", "metadata", "unknown"])
    .default("unknown"),
  name: z.string().nullable().default(null),
  symbol: z.string().nullable().default(null),
  creator: z.string().nullable().default(null),
  uri: z.string().nullable().default(null),
  image: z.string().nullable().default(null),
  website: z.string().nullable().default(null),
  twitter: z.string().nullable().default(null),
  telegram: z.string().nullable().default(null),
  bondingCurve: z.string().nullable().default(null),
  marketCapSol: z.number().nullable().default(null),
  priceSolPerToken: z.number().nullable().default(null),
  initialMarketCapSol: z.number().nullable().default(null),
  lastTradeAtMs: z.number().nullable().default(null),
  rawJson: z.string().nullable().default(null),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const PumpSwapSchema = z.object({
  signature: z.string(),
  mint: z.string(),
  slot: z.number().nullable().default(null),
  blockTime: z.number().nullable().default(null),
  side: z.enum(["buy", "sell", "unknown"]).default("unknown"),
  trader: z.string().nullable().default(null),
  tokenAmountRaw: z.string().nullable().default(null),
  tokenAmountUi: z.number().nullable().default(null),
  solAmountLamports: z.string().nullable().default(null),
  solAmount: z.number().nullable().default(null),
  marketCapSol: z.number().nullable().default(null),
  priceSolPerToken: z.number().nullable().default(null),
  source: z.string(),
  rawJson: z.string().nullable().default(null),
  createdAtMs: z.number(),
});

export const PumpHolderCurrentSchema = z.object({
  mint: z.string(),
  owner: z.string(),
  label: z.string().nullable().default(null),
  balanceRaw: z.string().nullable().default(null),
  balanceUi: z.number().nullable().default(null),
  pctSupply: z.number().nullable().default(null),
  lastDeltaRaw: z.string().nullable().default(null),
  lastDeltaUi: z.number().nullable().default(null),
  lastSignature: z.string().nullable().default(null),
  lastUpdatedMs: z.number(),
});

export const PumpBalanceDeltaSchema = z.object({
  mint: z.string(),
  owner: z.string(),
  signature: z.string(),
  side: z.enum(["buy", "sell", "unknown"]).default("unknown"),
  deltaRaw: z.string().nullable().default(null),
  deltaUi: z.number().nullable().default(null),
  postBalanceRaw: z.string().nullable().default(null),
  postBalanceUi: z.number().nullable().default(null),
  source: z.string(),
  blockTime: z.number().nullable().default(null),
  createdAtMs: z.number(),
});

export const PumpPriceAggregateSchema = z.object({
  mint: z.string(),
  intervalSeconds: z.number(),
  bucketStartMs: z.number(),
  smaMarketCapSol: z.number(),
  sampleCount: z.number(),
  sumMarketCapSol: z.number(),
  lastMarketCapSol: z.number(),
  updatedAtMs: z.number(),
});

export const LaunchJobSchema = z.object({
  jobId: z.string(),
  kind: z.enum(["launch:pump"]).default("launch:pump"),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  inputJson: z.string(),
  argvJson: z.string(),
  resultJson: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const LaunchJobLogSchema = z.object({
  jobId: z.string(),
  atMs: z.number(),
  label: z.string(),
  valueJson: z.string(),
});

export type WalletRow = z.infer<typeof WalletSchema> & { id: number };
export type TokenRow = z.infer<typeof TokenSchema> & { id: number };
export type ExecutionRow = z.infer<typeof ExecutionSchema> & { id: number };
export type ExecutionActionRow = z.infer<typeof ExecutionActionSchema> & {
  id: number;
};
export type PositionRow = z.infer<typeof PositionSchema> & { id: number };
export type BalanceRow = z.infer<typeof BalanceSchema> & { id: number };
export type PriceSampleRow = z.infer<typeof PriceSampleSchema> & { id: number };
export type ClaimRow = z.infer<typeof ClaimSchema> & { id: number };
export type GroupRow = z.infer<typeof GroupSchema> & { id: number };
export type GroupWalletRow = z.infer<typeof GroupWalletSchema> & { id: number };
export type AgentRow = z.infer<typeof AgentSchema> & { id: number };
export type AltRow = z.infer<typeof AltSchema> & { id: number };
export type WatchRow = z.infer<typeof WatchSchema> & { id: number };
export type TokenWatchGroupRow = z.infer<typeof TokenWatchGroupSchema> & {
  id: number;
};
export type TokenWatchGroupTokenRow = z.infer<
  typeof TokenWatchGroupTokenSchema
> & { id: number };
export type PumpTokenEventRow = z.infer<typeof PumpTokenEventSchema> & {
  id: number;
};
export type PumpSwapRow = z.infer<typeof PumpSwapSchema> & { id: number };
export type PumpHolderCurrentRow = z.infer<typeof PumpHolderCurrentSchema> & {
  id: number;
};
export type PumpBalanceDeltaRow = z.infer<typeof PumpBalanceDeltaSchema> & {
  id: number;
};
export type PumpPriceAggregateRow = z.infer<typeof PumpPriceAggregateSchema> & {
  id: number;
};
export type LaunchJobRow = z.infer<typeof LaunchJobSchema> & { id: number };
export type LaunchJobLogRow = z.infer<typeof LaunchJobLogSchema> & {
  id: number;
};

export type SowlDatabase = Database<{
  wallets: typeof WalletSchema;
  tokens: typeof TokenSchema;
  executions: typeof ExecutionSchema;
  executionActions: typeof ExecutionActionSchema;
  positions: typeof PositionSchema;
  balances: typeof BalanceSchema;
  priceSamples: typeof PriceSampleSchema;
  claims: typeof ClaimSchema;
  groups: typeof GroupSchema;
  groupWallets: typeof GroupWalletSchema;
  agents: typeof AgentSchema;
  alts: typeof AltSchema;
  watches: typeof WatchSchema;
  settings: typeof SettingSchema;
  tokenWatchGroups: typeof TokenWatchGroupSchema;
  tokenWatchGroupTokens: typeof TokenWatchGroupTokenSchema;
  pumpTokenEvents: typeof PumpTokenEventSchema;
  pumpSwaps: typeof PumpSwapSchema;
  pumpHoldersCurrent: typeof PumpHolderCurrentSchema;
  pumpBalanceDeltas: typeof PumpBalanceDeltaSchema;
  pumpPriceAggregates: typeof PumpPriceAggregateSchema;
  launchJobs: typeof LaunchJobSchema;
  launchJobLogs: typeof LaunchJobLogSchema;
}>;
