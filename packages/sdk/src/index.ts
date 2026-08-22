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
