import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database, z } from "sqlite-zod-orm";

const DEFAULT_DB_PATH = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".sowl",
  "sowl.sqlite",
);

export const SOLARD_DB_PATH =
  process.env.SOLARD_DB_PATH || process.env.SOWL_DB_PATH || DEFAULT_DB_PATH;

mkdirSync(dirname(SOLARD_DB_PATH), { recursive: true });

/**
 * sqlite-zod-orm owns every table in this module.
 *
 * Each table receives the ORM's numeric row `id`. Domain identifiers are
 * separate unique fields:
 *
 * - token mint       -> terminalTokens.mint
 * - trade identity   -> terminalTrades.eventKey
 * - SMA identity     -> terminalIndicators.indicatorKey
 * - ingestion dedupe -> terminalIndexerKeys.ingestionKey
 */
export const TerminalTokenSchema = z.object({
  mint: z.string(),
  symbol: z.string().default(""),
  name: z.string().default(""),
  image: z.string().nullable().default(null),
  uri: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  website: z.string().nullable().default(null),
  twitter: z.string().nullable().default(null),
  telegram: z.string().nullable().default(null),
  creator: z.string().nullable().default(null),
  bondingCurveKey: z.string().nullable().default(null),

  source: z.string().default("unknown"),
  phase: z.enum(["pump", "migrated", "unknown"]).default("unknown"),
  isMayhemMode: z.boolean().default(false),
  quoteAsset: z.string().nullable().default(null),
  quoteMint: z.string().nullable().default(null),

  supplyUi: z.number().default(1_000_000_000),
  priceSol: z.number().nullable().default(null),
  priceUsd: z.number().nullable().default(null),
  marketCapSol: z.number().nullable().default(null),
  marketCapUsd: z.number().nullable().default(null),
  initialMarketCapUsd: z.number().nullable().default(null),

  lastSlot: z.number().default(0),
  signature: z.string().nullable().default(null),
  rawJson: z.string().default("{}"),

  createdAtMs: z.number().default(0),
  priceUpdatedAtMs: z.number().default(0),
  updatedAtMs: z.number().default(0),
});

export const TerminalTradeSchema = z.object({
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

  createdAtMs: z.number().default(0),
  updatedAtMs: z.number().default(0),
});

export const TerminalIndicatorSchema = z.object({
  indicatorKey: z.string(),
  mint: z.string(),
  intervalSec: z.number(),

  smaPriceUsd: z.number().nullable().default(null),
  smaMarketCapUsd: z.number().nullable().default(null),
  medianPriceUsd: z.number().nullable().default(null),
  tradeCount: z.number().default(0),
  buyCount: z.number().default(0),
  sellCount: z.number().default(0),
  volumeSol: z.number().default(0),

  updatedAtMs: z.number().default(0),
});

export const TerminalIndexerKeySchema = z.object({
  ingestionKey: z.string(),
  kind: z.string(),
  seenAtMs: z.number(),
});

export const TerminalIndexerErrorSchema = z.object({
  errorKey: z.string(),
  worker: z.string(),
  message: z.string(),
  stack: z.string().nullable().default(null),
  dataJson: z.string().default("{}"),
  createdAtMs: z.number(),
});

export const ProcessStatusSchema = z.object({
  name: z.string(),
  kind: z.string(),
  status: z.string(),
  heartbeatAtMs: z.number(),
  dataJson: z.string().default("{}"),
  error: z.string().nullable().default(null),
});

export type TerminalTokenData = z.infer<typeof TerminalTokenSchema>;
export type TerminalTradeData = z.infer<typeof TerminalTradeSchema>;
export type TerminalIndicatorData = z.infer<typeof TerminalIndicatorSchema>;
export type TerminalIndexerKeyData = z.infer<typeof TerminalIndexerKeySchema>;
export type TerminalIndexerErrorData = z.infer<
  typeof TerminalIndexerErrorSchema
>;
export type ProcessStatusData = z.infer<typeof ProcessStatusSchema>;

export type TerminalTokenRow = TerminalTokenData & { id: number };
export type TerminalTradeRow = TerminalTradeData & { id: number };
export type TerminalIndicatorRow = TerminalIndicatorData & { id: number };
export type TerminalIndexerKeyRow = TerminalIndexerKeyData & {
  id: number;
};
export type TerminalIndexerErrorRow = TerminalIndexerErrorData & {
  id: number;
};
export type ProcessStatusRow = ProcessStatusData & { id: number };

export const terminalDb = new Database(
  SOLARD_DB_PATH,
  {
    terminalTokens: TerminalTokenSchema,
    terminalTrades: TerminalTradeSchema,
    terminalIndicators: TerminalIndicatorSchema,
    terminalIndexerKeys: TerminalIndexerKeySchema,
    terminalIndexerErrors: TerminalIndexerErrorSchema,
    processStatus: ProcessStatusSchema,
  },
  {
    timestamps: false,
    softDeletes: false,
    reactive: false,

    unique: {
      terminalTokens: [["mint"]],
      terminalTrades: [["eventKey"]],
      terminalIndicators: [["indicatorKey"], ["mint", "intervalSec"]],
      terminalIndexerKeys: [["ingestionKey"]],
      terminalIndexerErrors: [["errorKey"]],
      processStatus: [["name"]],
    },

    indexes: {
      terminalTokens: [
        "mint",
        "updatedAtMs",
        "priceUpdatedAtMs",
        "marketCapUsd",
        "source",
        ["source", "updatedAtMs"],
        ["isMayhemMode", "updatedAtMs"],
      ],
      terminalTrades: [
        "eventKey",
        "signature",
        "createdAtMs",
        "updatedAtMs",
        ["mint", "createdAtMs"],
        ["mint", "updatedAtMs"],
        ["source", "updatedAtMs"],
      ],
      terminalIndicators: [
        "indicatorKey",
        "updatedAtMs",
        ["mint", "intervalSec"],
      ],
      terminalIndexerKeys: ["ingestionKey", "seenAtMs", ["kind", "seenAtMs"]],
      terminalIndexerErrors: ["createdAtMs", ["worker", "createdAtMs"]],
      processStatus: ["heartbeatAtMs"],
    },
  },
);

export type TerminalDatabase = typeof terminalDb;
