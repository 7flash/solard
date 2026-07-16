/**
 * Compatibility barrel for indexer modules.
 *
 * All database ownership lives in shared/db.ts.
 */
export {
  SOLARD_DB_PATH,
  appendTokenTrade,
  appendCopyTradeIntentOnce,
  appendTokenTradeOnce,
  appendWalletSwapOnce,
  db,
  getCopyTradeIntent,
  getCopyTradeProfile,
  getCopyTradeTokenContext,
  getTokenPriceWindows,
  getWatchedWallet,
  listCopyTradeIntents,
  listCopyTradeProfiles,
  listProcessStatus,
  listTerminalFeed,
  listWatchedWallets,
  listWalletSwaps,
  listWalletTransactions,
  listWorkerErrors,
  recordWorkerError,
  terminalStoreStats,
  updateCopyTradeIntent,
  resetWatchedWalletBackfill,
  updateWatchedWalletCursor,
  upsertCopyTradeProfile,
  upsertProcessStatus,
  upsertTerminalToken,
  upsertWalletTransaction,
  upsertWatchedWallet,
} from "../shared/db.js";

export type {
  AppendCopyTradeIntentResult,
  AppendTokenTradeResult,
  AppendWalletSwapResult,
  CopyTradeIntent,
  CopyTradeProfile,
  CopyTradeTokenContext,
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
