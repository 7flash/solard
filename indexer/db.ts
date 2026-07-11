/**
 * Compatibility barrel for indexer modules.
 *
 * All database ownership lives in shared/db.ts.
 */
export {
  SOLARD_DB_PATH,
  appendTokenTrade,
  appendTokenTradeOnce,
  db,
  getTokenPriceWindows,
  listProcessStatus,
  listTerminalFeed,
  listWorkerErrors,
  recordWorkerError,
  terminalStoreStats,
  upsertProcessStatus,
  upsertTerminalToken,
} from "../shared/db.js";

export type {
  AppendTokenTradeResult,
  ProcessStatus,
  TerminalFeedRow,
  TerminalToken,
  TokenPriceWindows,
  TokenTrade,
  WorkerError,
} from "../shared/db.js";
