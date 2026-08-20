/**
 * Browser-safe Solard SDK.
 *
 * This entrypoint intentionally does NOT import @solard/core. There is no
 * SQLite, node:fs, Bun API, process.env, or server-side encrypted wallet DB in
 * its import graph.
 *
 * Use:
 *   import { createBrowserSolard } from "@solard/sdk/browser";
 */
export {
  BrowserSolard,
  SOL_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  createBrowserSolard,
} from "./client.ts";

export {
  BrowserSolardStore,
  MemoryBrowserStorage,
  defaultBrowserStorage,
} from "./storage.ts";

export { BrowserKeyVault, KeypairBrowserSigner } from "./wallet.ts";

export { buildJupiterDirectSwap, fetchJupiterBuild } from "./jupiter.ts";

export type {
  JupiterBrowserConfig,
  JupiterBuildOptions,
  JupiterBuildResponse,
  JupiterInstruction,
} from "./jupiter.ts";

export type {
  BrowserBroadcastResult,
  BrowserContact,
  BrowserPortfolio,
  BrowserSolardOptions,
  BrowserStorageLike,
  BrowserSwapBuild,
  BrowserSwapResult,
  BrowserTokenAlias,
  BrowserTokenBalance,
  BrowserWalletSigner,
} from "./types.ts";
