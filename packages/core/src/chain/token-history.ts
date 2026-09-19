/**
 * Durable Pump/PumpSwap historical research surface.
 *
 * Domain parsing/analysis are pure. RPC, persistence, defaults and service
 * orchestration are explicitly separated so tests can inject every side effect.
 */
export {
  findPumpHistoryCreateMarker,
  parsePumpHistoryTransaction,
} from "./token-history/parser.ts";
export {
  countTokenHistoryTrades,
  defaultTokenHistoryRepository,
  getTokenHistoryCoverage,
  loadTokenHistoryTrades,
  loadTokenHistoryCandles1s,
  persistTokenHistoryTrades,
  persistTokenHistoryCandles1s,
  replaceTokenHistoryTrades,
  replaceTokenHistoryCandles1s,
  saveTokenHistoryCoverage,
  SqliteTokenHistoryRepository,
} from "./token-history/repository.ts";
export { analyzeTokenHistoryTrades } from "./token-history/analysis.ts";
export { analyzeTokenHistoryForensics } from "./token-history/forensics.ts";
export {
  analyzeTokenHistoryForensicsFromStore,
  analyzeTokenHistoryForensicsWithRepository,
} from "./token-history/forensics-service.ts";
export { buildSparseTokenHistoryCandles1s } from "./token-history/candles.ts";
export {
  chronologicalTokenHistoryTrades,
  compareTokenHistoryTrades,
} from "./token-history/ordering.ts";
export {
  analyzeTokenHistory,
  analyzeTokenHistoryWithRepository,
} from "./token-history/analysis-service.ts";
export { backfillTokenHistory } from "./token-history/defaults.ts";
export {
  normalizeTokenHistoryRpcOptions,
  runTokenHistoryBackfill,
} from "./token-history/service.ts";
export {
  mergeTokenHistorySignatures,
  SolanaTokenHistoryRpc,
} from "./token-history/rpc.ts";
export {
  TokenHistoryError,
  tokenHistoryError,
} from "./token-history/errors.ts";
export { systemTokenHistoryClock } from "./token-history/clock.ts";
export type {
  TokenHistoryRepository,
  PersistTokenHistoryResult,
  TokenHistoryPersistProgress,
} from "./token-history/repository.ts";
export type {
  TokenHistoryRpc,
  TokenHistoryRpcOptions,
} from "./token-history/rpc.ts";
export type {
  TokenHistoryBackfillDependencies,
  TokenHistoryInspection,
  TokenHistoryMintInfo,
} from "./token-history/service.ts";
export type {
  TokenHistoryErrorCode,
  TokenHistoryErrorContext,
} from "./token-history/errors.ts";
export type {
  AddressHistoryCoverage,
  BackfillTokenHistoryOptions,
  NormalizedTokenHistoryRpcOptions,
  TokenHistoryAnalysis,
  TokenHistoryFirstBuyer,
  TokenHistoryForensics,
  TokenHistoryForensicsOptions,
  TokenHistoryOwnedEntry,
  TokenHistoryOwnerPnl,
  TokenHistoryPeriodSummary,
  PumpSwapFeeBreakdown,
  TokenHistoryBackfillProgress,
  TokenHistoryCandle1s,
  TokenHistoryClock,
  TokenHistoryCommitment,
  TokenHistoryConfidence,
  TokenHistoryCoverage,
  TokenHistoryRaw,
  TokenHistoryScanKind,
  TokenHistorySide,
  TokenHistoryTrade,
  TokenHistoryVenue,
} from "./token-history/types.ts";
