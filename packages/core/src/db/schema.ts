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

/** Venue-observed market price samples used by the SDK's price/watch APIs. */
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
export type SettingRow = z.infer<typeof SettingSchema> & { id: number };

export type SolardDatabase = Database<{
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
}>;
