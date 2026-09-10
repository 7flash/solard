/**
 * Public Solard SDK.
 *
 * All stateful behavior lives in @solard/core so the SDK and CLI share exactly
 * the same wallet store, transaction engine, venues, senders and database.
 */
export * from "@solard/core";

// Explicit source-level re-export for the generic Jupiter swap helpers.
// This avoids depending on the @solard/core package barrel resolution when the
// monorepo CLI is executed directly from source with Bun.
export {
  executeJupiterSwap,
  quoteJupiterSwap,
  executeJupiterTokenToSol,
  quoteJupiterTokenToSol,
} from "../../core/src/chain/jupiter-swap.ts";
export type {
  JupiterSwapExecuteResult,
  JupiterSwapOrder,
  JupiterSwapQuote,
} from "../../core/src/chain/jupiter-swap.ts";

// Direct source re-exports used by the source-executed CLI.
export { readMint } from "../../core/src/chain/state.ts";
export { transferTokenIxs } from "../../core/src/tx/spl.ts";
// Direct source re-exports for the target-weight portfolio controller and
// backtester. Keeping these explicit lets the source-executed CLI/examples use
// the new strategy without requiring a root @solard/core barrel replacement.
export {
  normalizeTargetWeightPolicy,
  planTargetWeightRebalance,
  targetWeightGapPct,
} from "../../core/src/strategy/target-weight.ts";
export type {
  TargetWeightCandle,
  TargetWeightGapMode,
  TargetWeightGapPolicy,
  TargetWeightPolicy,
  TargetWeightRebalancePlan,
} from "../../core/src/strategy/target-weight.ts";
export { simulateTargetWeightStrategy } from "../../core/src/backtest/target-weight-sim.ts";
export type {
  TargetWeightBacktestExecution,
  TargetWeightBacktestResult,
  TargetWeightBacktestSummary,
  TargetWeightDecision,
} from "../../core/src/backtest/target-weight-sim.ts";
export {
  backtestTargetWeightToken,
  backtestTargetWeightTokenWithDependencies,
} from "../../core/src/backtest/token-backtest.ts";
export type { TokenTargetWeightBacktestResult } from "../../core/src/backtest/token-backtest.ts";
