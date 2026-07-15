/**
 * Compatibility barrel for indexer modules.
 *
 * All database ownership lives in shared/db.ts.
 */
export {
  SOLARD_DB_PATH,
  appendTokenTrade,
  appendTokenTradeOnce,
  appendWalletSwapOnce,
  db,
  getTokenPriceWindows,
  getWatchedWallet,
  listProcessStatus,
  listTerminalFeed,
  listWatchedWallets,
  listWalletSwaps,
  listWorkerErrors,
  recordWorkerError,
  terminalStoreStats,
  updateWatchedWalletCursor,
  upsertProcessStatus,
  upsertTerminalToken,
  upsertWalletTransaction,
  upsertWatchedWallet,
} from "../shared/db.js";

export type {
  AppendTokenTradeResult,
  AppendWalletSwapResult,
  ProcessStatus,
  TerminalFeedRow,
  TerminalToken,
  TokenPriceWindows,
  TokenTrade,
  WatchedWallet,
  WalletSwap,
  WalletTransaction,
  WorkerError,
} from "../shared/db.js";
