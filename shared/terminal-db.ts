/**
 * @deprecated Compatibility facade for the pre-consolidation terminal store.
 *
 * This module intentionally constructs no Database. All callers share the
 * canonical instance from shared/db.ts.
 */
import { z } from "sqlite-zod-orm";
import {
  db,
  ProcessStatusSchema,
  SOLARD_DB_PATH,
  TerminalIndicatorSchema,
  TerminalTokenSchema,
  TokenTradeSchema,
  WorkerErrorSchema,
  type ProcessStatus,
  type TerminalIndicatorDbRow,
  type TerminalToken,
  type TokenTrade,
  type WorkerError,
} from "./db.js";

export {
  SOLARD_DB_PATH,
  TerminalTokenSchema,
  TerminalIndicatorSchema,
  ProcessStatusSchema,
};
export { TokenTradeSchema as TerminalTradeSchema };
export { WorkerErrorSchema as TerminalIndexerErrorSchema };

// Schema-only compatibility for code that still imports the old ingestion-key
// type. No second table or database owner is created.
export const TerminalIndexerKeySchema = z.object({
  ingestionKey: z.string(),
  kind: z.string(),
  seenAtMs: z.number(),
});

export const terminalDb = db;
export type TerminalDatabase = typeof db;

export type TerminalTokenData = TerminalToken;
export type TerminalTradeData = TokenTrade;
export type TerminalIndicatorData = TerminalIndicatorDbRow;
export type TerminalIndexerKeyData = z.infer<typeof TerminalIndexerKeySchema>;
export type TerminalIndexerErrorData = WorkerError;
export type ProcessStatusData = ProcessStatus;

export type TerminalTokenRow = TerminalToken & { id?: number };
export type TerminalTradeRow = TokenTrade & { id?: number };
export type TerminalIndicatorRow = TerminalIndicatorDbRow & { id?: number };
export type TerminalIndexerKeyRow = TerminalIndexerKeyData & { id?: number };
export type TerminalIndexerErrorRow = WorkerError & { id?: number };
export type ProcessStatusRow = ProcessStatus & { id?: number };
