/**
 * Browser-safe Solard SDK.
 *
 * Trading uses the same local Pump/PumpSwap venue classes, quote math and
 * instruction builders as the CLI/core engine. No external swap API is used.
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
export { buildLocalPumpBuy, buildLocalPumpSell } from "./pump.ts";
export {
  PUMP_USDC_MINT,
  buildPumpExternalDeployment,
  resolvePumpQuoteAsset,
} from "@solard/core/launches/pump/external-deployment.ts";
export type {
  PumpExternalDeploymentBuild,
  PumpCustomPairSelection,
  PumpLaunchPairInput,
} from "@solard/core/launches/pump/external-deployment.ts";
export { snapshotTokenHolders } from "@solard/core/chain/holders.ts";
export type {
  TokenHolder,
  ExcludedTokenHolder,
  TokenHolderSnapshot,
  TokenHolderSnapshotOptions,
} from "@solard/core/chain/holders.ts";
export { subscribeTokenEvents } from "@solard/core/events/token-events.ts";
export type {
  SolardTokenEvent,
  SolardTokenSwapEvent,
  SolardTokenTransferEvent,
  SubscribeTokenEventsOptions,
  TokenEventSubscription,
} from "@solard/core/events/token-events.ts";

export type {
  BrowserBroadcastResult,
  BrowserContact,
  BrowserPortfolio,
  BrowserPumpDeploymentBuild,
  BrowserPumpDeploymentResult,
  BrowserSolardOptions,
  BrowserStorageLike,
  BrowserTokenAlias,
  BrowserTokenBalance,
  BrowserTradeBuild,
  BrowserTradeResult,
  BrowserTradeSide,
  BrowserWalletSigner,
} from "./types.ts";
