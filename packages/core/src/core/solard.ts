import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { AccountCache } from "../chain/account-cache.ts";
import { BlockhashCache } from "../chain/blockhash.ts";
import { SolardConnection } from "../chain/connection.ts";
import {
  listOwnedTokenAccounts,
  readMint,
  readTokenAmount,
  type OwnedTokenAccount,
} from "../chain/state.ts";
import {
  snapshotTokenHolders,
  type TokenHolderSnapshotOptions,
} from "../chain/holders.ts";
import {
  backfillTokenHistory,
  type BackfillTokenHistoryOptions,
  type TokenHistoryBackfillProgress,
  type TokenHistoryCandle1s,
  type TokenHistoryCoverage,
} from "../chain/token-history.ts";
import { backfillRaydiumTokenHistory } from "../chain/token-history/raydium-backfill.ts";
import { SqliteTokenHistoryRepository } from "../chain/token-history/repository.ts";
import { TokenHistoryError } from "../chain/token-history/errors.ts";
import {
  subscribeTokenEvents as openTokenEventStream,
  type SubscribeTokenEventsOptions,
  type TokenEventSubscription,
} from "../events/token-events.ts";
import {
  historyTokenEvents as openTokenEventHistory,
  type TokenEventHistory,
  type TokenEventHistoryOptions,
} from "../events/token-event-history.ts";
import {
  mergeReplayEventSubscriptions,
  mergeReplayHistories,
  replayCoverageThroughSlot,
  replayTokenHistory,
  subscribeReplayEvents,
  type MergedReplayEventStream,
  type ReplayEventSubscription,
  type ReplayEventsOptions,
  type ReplayHistory,
  type ReplayItem,
  type ReplayOptions,
} from "../history/replay.ts";
import { simulatePlanned } from "../chain/simulate.ts";
import {
  SOL_ASSET,
  sameAsset,
  rawAmount,
  toRawAmount,
  type HumanAmount,
  type QuoteAsset,
} from "../core/amounts.ts";
import {
  QuoteAssetMismatchError,
  isDefinitivePreSubmissionError,
} from "../core/errors.ts";
import { verifyPoolTokenMetadata, mergeTokenMetadataJson } from "../venues/pump/token-metadata.ts";
import { TradePreSubmissionError } from "../tx/trade-errors.ts";
import { TradeIntentStore } from "../tx/trade-intent.ts";
import { checkPlanBalance } from "../tx/balance-preflight.ts";
import { estimatePlanFee } from "../tx/fee-estimate.ts";
import { isComputeExhausted, simulationComputeLimit } from "../tx/compute-sizing.ts";
import { addHeliusLandingTip } from "../tx/helius-landing.ts";
import { prepareTokenAccountMaintenance, type TokenMaintenanceOptions } from "../chain/token-maintenance.ts";
import { getClaimableCreatorFees as discoverCreatorFees, batchCreatorFeePlans } from "../claims/creator-fees.ts";
import { loadHistoricalTradeTape } from "../backtest/historical.ts";
import type { TokenBacktestTapeOptions } from "../backtest/tape.ts";
import { resolveCurrentMarket as loadCurrentMarket } from "../market/current-market.ts";
import { walletLedger as loadWalletLedger, walletLedgerEntry, type WalletLedgerOptions, type WalletLedgerEntry } from "../ledger/wallet-ledger.ts";
import { createRawTransactionCachingConnection } from "../events/raw-transaction-cache.ts";
import { getSupportedPumpPairs as loadPumpPairs } from "../launches/pump/pairs.ts";
import { listVanityMintPool, reserveVanityMintFromPool, releaseVanityMintReservation, markVanityMintUsed } from "../launches/pump/vanity-pool.ts";
import { fetchCurve } from "../venues/pump/state.ts";
import { failedTrade, tradeResult, type TradeResult } from "../tx/trade-result.ts";
import { notifyTrade, type TradeExecutionOptions } from "../tx/trade-options.ts";
import { chooseTradeFee, normalizeLandingPolicy, runTradeAttempts, type TradeLandingPolicy } from "../tx/trade-policy.ts";
import { inspectExpiredSubmission } from "../tx/expiry.ts";
import { optionalDecimals } from "../core/decimals.ts";
import type { GroupRef, TokenRef, WalletRef } from "../core/refs.ts";
import {
  LaunchSourceRegistry,
  type DiscoveredLaunch,
  type LaunchSourcePlugin,
  type WaitForLaunchArgs,
} from "../launches/launch-source.ts";
import {
  LaunchpadRegistry,
  type PendingMarketState,
  type PrepareDeploymentArgs,
  type PreparedPendingBuy,
  type PreparedTokenDeployment,
  type TokenLaunchpadPlugin,
} from "../launches/launchpad.ts";
import { measure } from "../core/log.ts";
import {
  simulationLog,
  submittedPlanLog,
  tokenLog,
} from "../core/log-result.ts";
import { measured } from "../core/measured.ts";
import { openDatabase, closeDatabase, resolveDbPath } from "../db/database.ts";
import { AgentRepo } from "../db/agent-repo.ts";
import { AltRepo } from "../db/alt-repo.ts";
import { ExecutionRepo } from "../db/execution-repo.ts";
import { PriceRepo, type PriceWindow } from "../db/price-repo.ts";
import { GroupRepo } from "../db/group-repo.ts";
import type { ExecutionRow, SolardDatabase, TokenRow } from "../db/schema.ts";
import { TokenRepo } from "../db/token-repo.ts";
import { WalletRepo, type WalletInfo } from "../db/wallet-repo.ts";
import bs58 from "bs58";
import { PositionStore } from "../runtime/positions.ts";
import { SolardAgent } from "../runtime/agent.ts";
import { SolardWatcher } from "../runtime/watcher.ts";
import { assembleTransaction } from "../tx/assemble.ts";
import { confirmSignature } from "../tx/confirm.ts";
import {
  BatchComposer,
  TransactionComposer,
  type ComposerHost,
} from "../tx/composer.ts";
import { HeliusSender } from "../tx/senders/helius-sender.ts";
import {
  isJitoBundleExpiredError,
  isJitoBundleGenerationRetryError,
  JitoBundleExpiredError,
  JitoBundleGenerationRetryError,
  JitoSender,
} from "../tx/senders/jito-sender.ts";
import { RpcSender } from "../tx/senders/rpc-sender.ts";
import {
  SenderRegistry,
  isBundleSender,
  type SolardSender,
} from "../tx/sender.ts";
import {
  SolardTransaction,
  TransactionBuilder,
} from "../tx/transaction-builder.ts";
import {
  packTransferMany,
  type TransferManyAllocation,
} from "../tx/transfer-batch.ts";
import {
  durableTransferManyStatus,
  executeDurableTransferMany,
  resumeDurableTransferMany,
  type DurableTransferManyResumeOptions,
} from "../tx/durable-transfer-many.ts";
import {
  executeCumulativeDistribution,
  getCumulativeDistributionState,
  planCumulativeDistribution,
  type CumulativeDistributionExecuteOptions,
  type CumulativeDistributionInput,
  type CumulativeDistributionPlan,
  type CumulativeDistributionState,
} from "../distributions/cumulative.ts";
import {
  claimCreatorRewards,
  getCreatorRewardClaimState,
  type ClaimCreatorRewardsOptions,
  type CreatorRewardClaimResult,
  type DurableCreatorRewardClaimState,
} from "../rewards/creator-claim.ts";
import {
  historyCreatorRewards,
  type CreatorRewardHistory,
  type CreatorRewardHistoryOptions,
} from "../rewards/creator-reward-history.ts";
import type {
  BatchSendReceipt,
  PlannedTransaction,
  SendOptions,
  SendReceipt,
  SenderId,
  SimulationResult,
  SubmittedPlan,
  TransactionDraft,
} from "../tx/types.ts";
import { VenueRegistry } from "../venues/route-resolver.ts";
import type { MarketPrice, TradeVenuePlugin } from "../venues/venue-plugin.ts";
import {
  ClaimSourceRegistry,
  type ClaimPlan,
  type ClaimSourcePlugin,
} from "../claims/claim-source.ts";
import {
  cacheParsedTransaction,
  deserializeParsedTransaction,
} from "../events/raw-transaction-cache.ts";
import { trace } from "../core/trace.ts";
import { MeteoraDlmmService } from "../venues/meteora/index.ts";
import { GmgnReadService } from "../data/gmgn.ts";
import { PumpPairService } from "../launches/pump/pairs.ts";
import {
  generateMintKeypairWithSuffix,
  type VanityMintOptions,
} from "../launches/pump/vanity-mint.ts";

const m = measure("sdk");
const BUNDLE_TRANSACTION_LIMIT = 5;
const JITO_TIP_ACCOUNTS = [
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
];

function jitoTipLamports(): bigint {
  const value = BigInt(process.env.JITO_TIP_LAMPORTS ?? "100000");
  if (value < 1000n) throw new Error("JITO_TIP_LAMPORTS must be at least 1000");
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("JITO_TIP_LAMPORTS exceeds JS safe integer range");
  return value;
}

function randomJitoTipAccount(): PublicKey {
  return new PublicKey(
    JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!,
  );
}

function chunkPlans<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    chunks.push(values.slice(index, index + size));
  return chunks;
}

export type SolardOptions = {
  rpcUrl?: string;
  rpcUrls?: readonly string[];
  dbPath?: string;
  cacheTtlMs?: number;
  venues?: TradeVenuePlugin[];
  claimSources?: ClaimSourcePlugin[];
  launchSources?: LaunchSourcePlugin[];
  launchpads?: TokenLaunchpadPlugin[];
  senders?: SolardSender[];
};

function isPumpSwap6040SimulationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("Simulation failed")) return false;
  if (message.includes("BuySlippageBelowMinBaseAmountOut")) return true;
  const mentionsPumpSwap = message.includes(
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  );
  return (
    mentionsPumpSwap &&
    (message.includes("Error Number: 6040") ||
      /["']?Custom["']?\s*[:=]\s*6040/.test(message))
  );
}

export type SolardEventsApi = {
  (
    tokenRef: TokenRef,
    options?: ReplayEventsOptions,
  ): Promise<ReplayEventSubscription>;
  merge: (
    streams: readonly ReplayEventSubscription[],
  ) => MergedReplayEventStream;
  subscribeToken: (
    tokenRef: TokenRef,
    options?: SubscribeTokenEventsOptions,
  ) => Promise<TokenEventSubscription>;
  history: (
    tokenRef: TokenRef,
    options?: TokenEventHistoryOptions,
  ) => Promise<TokenEventHistory>;
};

export type MarketHistoryOptions = Omit<
  BackfillTokenHistoryOptions,
  "onProgress"
> & {
  backfill?: boolean;
  maxRaydiumPools?: number;
  onProgress?: (progress: TokenHistoryBackfillProgress) => void;
};

export type MarketHistory = {
  mint: string;
  quoteMint: string;
  coverage: TokenHistoryCoverage;
  candles1s: readonly TokenHistoryCandle1s[];
};

export type WalletPrivateKeyFormat = "base58" | "json";

export type WalletPrivateKeyExport = {
  wallet: WalletInfo;
  format: WalletPrivateKeyFormat;
  privateKey: string;
};

export type SolardTradeStatus = ExecutionRow["status"];
export type SolardTradeSide = "buy" | "sell";

export type SolardTradeQuery = {
  wallet?: WalletRef;
  token?: TokenRef;
  status?: SolardTradeStatus | readonly SolardTradeStatus[];
  side?: SolardTradeSide;
  limit?: number;
};

export type RecordConfirmedTradeInput = {
  signature: string;
  wallet: WalletRef;
  token: TokenRef;
  side: SolardTradeSide;
  venue?: string;
  sender?: string;
};

export type SolardPositionQuery = {
  wallet: WalletRef;
  token: TokenRef;
};

export type SolardPosition = {
  wallet: string;
  mint: string;
  amountRaw: bigint;
  decimals: number;
  amountUi: number;
  solLamports: bigint;
  sol: number;
  capturedAtMs: number;
};

export type SolardTransactionOptions = {
  commitment?: "confirmed" | "finalized";
  forceRefresh?: boolean;
};

export type SolardTransactionTokenBalance = {
  accountIndex: number;
  owner: string | null;
  mint: string;
  decimals: number;
  beforeRaw: bigint;
  afterRaw: bigint;
  deltaRaw: bigint;
};

export type SolardTransactionNativeBalance = {
  accountIndex: number;
  address: string;
  beforeLamports: bigint;
  afterLamports: bigint;
  deltaLamports: bigint;
};

export type SolardDecodedTransaction = {
  signature: string;
  slot: number;
  blockTimeMs: number | null;
  confidence: "confirmed" | "finalized";
  status: "confirmed" | "failed";
  error: unknown | null;
  feeLamports: bigint;
  computeUnitsConsumed: number | null;
  accounts: string[];
  tokenBalances: SolardTransactionTokenBalance[];
  nativeBalances: SolardTransactionNativeBalance[];
  instructions: unknown[];
  innerInstructions: unknown[];
  logs: string[];
  raw: ParsedTransactionWithMeta;
};

export type SolardTrade = {
  executionId: number;
  signature: string | null;
  wallet: string;
  mint: string;
  side: SolardTradeSide;
  status: SolardTradeStatus;
  sender: string | null;
  venue: string | null;
  slot: number | null;
  error: string | null;
  tokenDeltaRaw: bigint | null;
  tokenDecimals: number | null;
  tokenAmountUi: number | null;
  solDeltaLamports: bigint | null;
  solAmount: number | null;
  networkFeeLamports: bigint | null;
  ownerNativeDeltaLamports: bigint | null;
  tokenAccountLamportDelta: bigint | null;
  priceSol: number | null;
  confirmedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
};

function signedPlanSignature(plan: PlannedTransaction): string {
  const bytes = plan.transaction.signatures[0];
  if (!bytes || bytes.length === 0 || [...bytes].every((value) => value === 0))
    throw new Error("Compiled transaction is missing its payer signature");
  return bs58.encode(bytes);
}
function tradeTokenKey(token: TokenRef): string {
  return typeof token === "string" ? token : token instanceof PublicKey ? token.toBase58() : token.mint;
}

function definitiveSubmissionFailure(error: unknown): boolean {
  return isDefinitivePreSubmissionError(error);
}

async function waitForSignatureSeen(
  connection: Connection,
  signature: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const status = (
        await connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        })
      ).value[0];
      if (status) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

function transactionTokenBalances(
  tx: ParsedTransactionWithMeta,
): SolardTransactionTokenBalance[] {
  const rows = new Map<string, SolardTransactionTokenBalance>();
  const apply = (
    values: readonly any[] | null | undefined,
    phase: "before" | "after",
  ) => {
    for (const value of values ?? []) {
      const accountIndex = Number(value.accountIndex);
      const mint = String(value.mint ?? "");
      const owner = value.owner == null ? null : transactionKey(value.owner);
      const amount = value.uiTokenAmount?.amount;
      const decimals = Number(value.uiTokenAmount?.decimals);
      if (
        !Number.isInteger(accountIndex) ||
        accountIndex < 0 ||
        !mint ||
        typeof amount !== "string" ||
        !/^-?\d+$/.test(amount)
      )
        continue;
      const key = `${accountIndex}:${mint}:${owner ?? ""}`;
      const current = rows.get(key) ?? {
        accountIndex,
        owner,
        mint,
        decimals: Number.isInteger(decimals) && decimals >= 0 ? decimals : 0,
        beforeRaw: 0n,
        afterRaw: 0n,
        deltaRaw: 0n,
      };
      if (phase === "before") current.beforeRaw = BigInt(amount);
      else current.afterRaw = BigInt(amount);
      current.deltaRaw = current.afterRaw - current.beforeRaw;
      rows.set(key, current);
    }
  };
  apply(tx.meta?.preTokenBalances, "before");
  apply(tx.meta?.postTokenBalances, "after");
  return [...rows.values()].sort(
    (a, b) => a.accountIndex - b.accountIndex || a.mint.localeCompare(b.mint),
  );
}

function decodedTransaction(
  signature: string,
  tx: ParsedTransactionWithMeta,
  confidence: "confirmed" | "finalized",
): SolardDecodedTransaction {
  const accounts = transactionKeys(tx);
  const preBalances = tx.meta?.preBalances ?? [];
  const postBalances = tx.meta?.postBalances ?? [];
  const nativeBalances: SolardTransactionNativeBalance[] = [];
  for (
    let index = 0;
    index < Math.max(accounts.length, preBalances.length, postBalances.length);
    index += 1
  ) {
    const address = accounts[index];
    if (!address || preBalances[index] == null || postBalances[index] == null)
      continue;
    const beforeLamports = BigInt(preBalances[index]!);
    const afterLamports = BigInt(postBalances[index]!);
    nativeBalances.push({
      accountIndex: index,
      address,
      beforeLamports,
      afterLamports,
      deltaLamports: afterLamports - beforeLamports,
    });
  }
  const message = tx.transaction.message as any;
  return {
    signature,
    slot: tx.slot,
    blockTimeMs: tx.blockTime == null ? null : tx.blockTime * 1_000,
    confidence,
    status: tx.meta?.err ? "failed" : "confirmed",
    error: tx.meta?.err ?? null,
    feeLamports: BigInt(tx.meta?.fee ?? 0),
    computeUnitsConsumed:
      tx.meta?.computeUnitsConsumed == null
        ? null
        : Number(tx.meta.computeUnitsConsumed),
    accounts,
    tokenBalances: transactionTokenBalances(tx),
    nativeBalances,
    instructions: Array.isArray(message?.instructions)
      ? message.instructions
      : [],
    innerInstructions: Array.isArray(tx.meta?.innerInstructions)
      ? tx.meta.innerInstructions
      : [],
    logs: Array.isArray(tx.meta?.logMessages) ? tx.meta.logMessages : [],
    raw: tx,
  };
}

type StoredTradeFill = {
  version: 1;
  tokenDeltaRaw: string;
  tokenDecimals: number | null;
  economicLamports: string;
  networkFeeLamports: string;
  ownerNativeDeltaLamports: string;
  tokenAccountLamportDelta: string;
  confirmedAtMs: number;
};

function executionTradeSide(kind: string): SolardTradeSide | null {
  if (kind === "buy" || kind.startsWith("buy:")) return "buy";
  if (kind === "sell" || kind.startsWith("sell:")) return "sell";
  return null;
}

function executionMeta(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function storedTradeFill(row: ExecutionRow): StoredTradeFill | null {
  const value = executionMeta(row.metaJson).tradeFill;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fill = value as Record<string, unknown>;
  if (fill.version !== 1) return null;
  for (const key of [
    "tokenDeltaRaw",
    "economicLamports",
    "networkFeeLamports",
    "ownerNativeDeltaLamports",
    "tokenAccountLamportDelta",
  ]) {
    if (typeof fill[key] !== "string" || !/^-?\d+$/.test(fill[key] as string))
      return null;
  }
  const tokenDecimals =
    fill.tokenDecimals == null
      ? null
      : Number.isInteger(fill.tokenDecimals) && Number(fill.tokenDecimals) >= 0
        ? Number(fill.tokenDecimals)
        : null;
  const confirmedAtMs = Number(fill.confirmedAtMs);
  if (!Number.isFinite(confirmedAtMs) || confirmedAtMs <= 0) return null;
  return {
    version: 1,
    tokenDeltaRaw: fill.tokenDeltaRaw as string,
    tokenDecimals,
    economicLamports: fill.economicLamports as string,
    networkFeeLamports: fill.networkFeeLamports as string,
    ownerNativeDeltaLamports: fill.ownerNativeDeltaLamports as string,
    tokenAccountLamportDelta: fill.tokenAccountLamportDelta as string,
    confirmedAtMs,
  };
}

function transactionKey(value: unknown): string {
  if (typeof value === "string") return value;
  const row = value as {
    pubkey?: unknown;
    toBase58?: () => string;
  };
  if (typeof row?.pubkey === "string") return row.pubkey;
  if (
    typeof (row?.pubkey as { toBase58?: () => string })?.toBase58 === "function"
  )
    return (row.pubkey as { toBase58: () => string }).toBase58();
  if (typeof row?.toBase58 === "function") return row.toBase58();
  return String(value ?? "");
}

function transactionKeys(tx: any): string[] {
  const message = tx?.transaction?.message;
  if (Array.isArray(message?.accountKeys))
    return message.accountKeys.map(transactionKey);
  if (!Array.isArray(message?.staticAccountKeys)) return [];
  const keys = message.staticAccountKeys.map(transactionKey);
  const loaded = tx?.meta?.loadedAddresses;
  if (Array.isArray(loaded?.writable))
    keys.push(...loaded.writable.map(transactionKey));
  if (Array.isArray(loaded?.readonly))
    keys.push(...loaded.readonly.map(transactionKey));
  return keys;
}

function ownerTokenRaw(
  rows: any[] | null | undefined,
  owner: string,
  mint: string,
): { raw: bigint; decimals: number | null } {
  let raw = 0n;
  let decimals: number | null = null;
  for (const row of rows ?? []) {
    if (
      transactionKey(row?.owner) !== owner ||
      String(row?.mint ?? "") !== mint
    )
      continue;
    const amount = row?.uiTokenAmount?.amount;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) continue;
    raw += BigInt(amount);
    const value = Number(row?.uiTokenAmount?.decimals);
    if (Number.isInteger(value) && value >= 0) decimals = value;
  }
  return { raw, decimals };
}

function transactionSolFill(
  tx: any,
  owner: string,
): {
  economicLamports: bigint;
  networkFeeLamports: bigint;
  ownerNativeDeltaLamports: bigint;
  tokenAccountLamportDelta: bigint;
} | null {
  const keys = transactionKeys(tx);
  const ownerIndex = keys.indexOf(owner);
  const preBalances = tx?.meta?.preBalances;
  const postBalances = tx?.meta?.postBalances;
  if (
    ownerIndex < 0 ||
    !Array.isArray(preBalances) ||
    !Array.isArray(postBalances) ||
    preBalances[ownerIndex] == null ||
    postBalances[ownerIndex] == null
  )
    return null;
  const networkFeeLamports = BigInt(tx?.meta?.fee ?? 0);
  const ownerNativeDeltaLamports =
    BigInt(postBalances[ownerIndex]) - BigInt(preBalances[ownerIndex]);
  const adjustedNative =
    ownerNativeDeltaLamports + (ownerIndex === 0 ? networkFeeLamports : 0n);
  const tokenIndexes = new Set<number>();
  for (const row of [
    ...(tx?.meta?.preTokenBalances ?? []),
    ...(tx?.meta?.postTokenBalances ?? []),
  ]) {
    if (transactionKey(row?.owner) !== owner) continue;
    const index = Number(row?.accountIndex);
    if (Number.isInteger(index) && index >= 0 && index !== ownerIndex)
      tokenIndexes.add(index);
  }
  let tokenAccountLamportDelta = 0n;
  for (const index of tokenIndexes) {
    if (preBalances[index] == null || postBalances[index] == null) continue;
    tokenAccountLamportDelta +=
      BigInt(postBalances[index]) - BigInt(preBalances[index]);
  }
  return {
    economicLamports: adjustedNative + tokenAccountLamportDelta,
    networkFeeLamports,
    ownerNativeDeltaLamports,
    tokenAccountLamportDelta,
  };
}

function executionAsTrade(row: ExecutionRow): SolardTrade | null {
  const side = executionTradeSide(row.kind);
  if (!side || !row.mint) return null;
  const fill = storedTradeFill(row);
  const tokenDeltaRaw = fill ? BigInt(fill.tokenDeltaRaw) : null;
  const solDeltaLamports = fill ? BigInt(fill.economicLamports) : null;
  const tokenAmountUi =
    tokenDeltaRaw != null && fill?.tokenDecimals != null
      ? Number(tokenDeltaRaw < 0n ? -tokenDeltaRaw : tokenDeltaRaw) /
        10 ** fill.tokenDecimals
      : null;
  const solAmount =
    solDeltaLamports == null
      ? null
      : Number(solDeltaLamports < 0n ? -solDeltaLamports : solDeltaLamports) /
        1_000_000_000;
  const priceSol =
    tokenAmountUi != null && tokenAmountUi > 0 && solAmount != null
      ? solAmount / tokenAmountUi
      : null;
  return {
    executionId: row.id,
    signature: row.signature,
    wallet: row.walletAddress,
    mint: row.mint,
    side,
    status: row.status,
    sender: row.sender,
    venue: row.venue,
    slot: row.slot,
    error: row.error,
    tokenDeltaRaw,
    tokenDecimals: fill?.tokenDecimals ?? null,
    tokenAmountUi,
    solDeltaLamports,
    solAmount,
    networkFeeLamports: fill ? BigInt(fill.networkFeeLamports) : null,
    ownerNativeDeltaLamports: fill
      ? BigInt(fill.ownerNativeDeltaLamports)
      : null,
    tokenAccountLamportDelta: fill
      ? BigInt(fill.tokenAccountLamportDelta)
      : null,
    priceSol,
    confirmedAtMs: fill?.confirmedAtMs ?? null,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

export type SolardHistoryApi = {
  replay: (
    tokenRef: TokenRef,
    options?: ReplayOptions,
  ) => Promise<ReplayHistory>;
  market: (
    tokenRef: TokenRef,
    options?: MarketHistoryOptions,
  ) => Promise<MarketHistory>;
  merge: (
    histories: readonly (ReplayHistory | Iterable<ReplayItem>)[],
  ) => ReplayItem[];
};

export class Solard implements ComposerHost {
  readonly db: SolardDatabase;
  readonly wallets: WalletRepo;
  readonly tokens: TokenRepo;
  readonly groups: GroupRepo;
  readonly executions: ExecutionRepo;
  readonly positions: PositionStore;
  readonly prices: PriceRepo;
  readonly alts: AltRepo;
  readonly watcher: SolardWatcher;
  readonly meteora: MeteoraDlmmService;
  readonly gmgn: GmgnReadService;
  readonly pump: PumpPairService;
  readonly events: SolardEventsApi;
  readonly history: SolardHistoryApi;
  readonly claims: {
    creatorFees: {
      claim: (
        tokenRef: TokenRef,
        wallet: WalletRef,
        options?: ClaimCreatorRewardsOptions,
      ) => Promise<CreatorRewardClaimResult>;
      status: (id: string) => DurableCreatorRewardClaimState | null;
    };
  };
  readonly distributions: {
    plan: (
      options: CumulativeDistributionInput,
    ) => Promise<CumulativeDistributionPlan>;
    execute: (
      options: CumulativeDistributionExecuteOptions,
    ) => Promise<CumulativeDistributionState>;
    status: (id: string) => CumulativeDistributionState | null;
  };
  readonly venues = new VenueRegistry();
  readonly claimSources = new ClaimSourceRegistry();
  readonly launches = new LaunchSourceRegistry();
  readonly launchpads = new LaunchpadRegistry();
  readonly senders = new SenderRegistry();
  readonly cache: AccountCache;
  readonly blockhash = new BlockhashCache();
  private readonly chain: SolardConnection;
  private readonly agentRepo: AgentRepo;
  private readonly pendingExecutionTokens = new Map<
    string,
    Promise<TokenRow>
  >();
  private readonly dbPath: string;
  private closed = false;

  constructor(options: SolardOptions = {}) {
    trace("construct: opening database");
    this.dbPath = resolveDbPath(options.dbPath);
    this.db = openDatabase(this.dbPath);
    trace("construct: database ready");
    this.wallets = new WalletRepo(this.db);
    this.tokens = new TokenRepo(this.db);
    this.groups = new GroupRepo(this.db);
    this.executions = new ExecutionRepo(this.db);
    this.positions = new PositionStore(this.db);
    this.prices = new PriceRepo(this.db);
    this.alts = new AltRepo(this.db);
    this.agentRepo = new AgentRepo(this.db);
    this.chain = new SolardConnection(options.rpcUrl, "confirmed", { rpcUrls: options.rpcUrls });
    this.cache = new AccountCache(options.cacheTtlMs);
    this.watcher = new SolardWatcher(this.db, () => this.connection());
    this.meteora = new MeteoraDlmmService({
      connection: () => this.connection(),
      signer: (ref) => this.signer(ref),
      walletAddress: (ref) => this.resolveWallet(ref).address,
    });
    this.gmgn = new GmgnReadService();
    this.pump = new PumpPairService(() => this.connection());
    this.events = Object.assign(
      (tokenRef: TokenRef, eventOptions: ReplayEventsOptions = {}) =>
        this.replayEvents(tokenRef, eventOptions),
      {
        merge: (streams: readonly ReplayEventSubscription[]) =>
          mergeReplayEventSubscriptions(streams),
        subscribeToken: (
          tokenRef: TokenRef,
          eventOptions: SubscribeTokenEventsOptions = {},
        ) => this.subscribeTokenEvents(tokenRef, eventOptions),
        history: (
          tokenRef: TokenRef,
          eventOptions: TokenEventHistoryOptions = {},
        ) => this.historyTokenEvents(tokenRef, eventOptions),
      },
    );
    this.history = {
      replay: (tokenRef, replayOptions = {}) =>
        this.replayHistory(tokenRef, replayOptions),
      market: (tokenRef, marketOptions = {}) =>
        this.marketHistory(tokenRef, marketOptions),
      merge: (histories) => mergeReplayHistories(histories),
    };
    this.claims = {
      creatorFees: {
        claim: (tokenRef, wallet, claimOptions = {}) =>
          this.claimCreatorFees(tokenRef, wallet, claimOptions),
        status: (id) => getCreatorRewardClaimState(this, id),
      },
    };
    this.distributions = {
      plan: (distributionOptions) =>
        planCumulativeDistribution(this, distributionOptions),
      execute: (distributionOptions) =>
        executeCumulativeDistribution(this, distributionOptions),
      status: (id) => getCumulativeDistributionState(this, id),
    };
    for (const venue of options.venues ?? []) this.venues.register(venue);
    for (const source of options.claimSources ?? [])
      this.claimSources.register(source);
    for (const source of options.launchSources ?? [])
      this.launches.register(source);
    for (const launchpad of options.launchpads ?? [])
      this.launchpads.register(launchpad);
    this.senders
      .register(new RpcSender())
      .register(new HeliusSender())
      .register(new HeliusSender(undefined, "helius-swqos"))
      .register(new HeliusSender(undefined, "helius-max"))
      .register(new JitoSender());
    for (const sender of options.senders ?? []) this.senders.register(sender);
    trace("construct: repositories, registries and senders ready");
  }

  private async captureExecutionTradeFill(
    execution: ExecutionRow,
  ): Promise<void> {
    const side = executionTradeSide(execution.kind);
    if (
      !side ||
      execution.status !== "confirmed" ||
      !execution.signature ||
      !execution.mint ||
      storedTradeFill(execution)
    )
      return;
    const tx = await this.connection().getTransaction(execution.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta || tx.meta.err) return;
    const pre = ownerTokenRaw(
      tx.meta.preTokenBalances,
      execution.walletAddress,
      execution.mint,
    );
    const post = ownerTokenRaw(
      tx.meta.postTokenBalances,
      execution.walletAddress,
      execution.mint,
    );
    const tokenDeltaRaw = post.raw - pre.raw;
    if (
      tokenDeltaRaw === 0n ||
      (side === "buy" && tokenDeltaRaw < 0n) ||
      (side === "sell" && tokenDeltaRaw > 0n)
    )
      return;
    const sol = transactionSolFill(tx, execution.walletAddress);
    if (!sol) return;
    const meta = executionMeta(execution.metaJson);
    const tipLamports = typeof meta.landingTipLamports === "number" && Number.isSafeInteger(meta.landingTipLamports) && meta.landingTipLamports >= 0 ? BigInt(meta.landingTipLamports) : 0n;
    const principalLamports = sol.economicLamports + tipLamports;
    if (
      (side === "buy" && principalLamports >= 0n) ||
      (side === "sell" && principalLamports <= 0n)
    )
      return;
    const fill: StoredTradeFill = {
      version: 1,
      tokenDeltaRaw: tokenDeltaRaw.toString(),
      tokenDecimals: post.decimals ?? pre.decimals,
      economicLamports: principalLamports.toString(),
      networkFeeLamports: sol.networkFeeLamports.toString(),
      ownerNativeDeltaLamports: sol.ownerNativeDeltaLamports.toString(),
      tokenAccountLamportDelta: sol.tokenAccountLamportDelta.toString(),
      confirmedAtMs:
        typeof tx.blockTime === "number" ? tx.blockTime * 1_000 : Date.now(),
    };
    this.executions.update(execution, {
      metaJson: JSON.stringify({ ...meta, tradeFill: fill }),
    });
  }

  private async refreshExecutionTradeStatus(
    execution: ExecutionRow,
  ): Promise<void> {
    if (execution.status !== "submitted" || !execution.signature) return;
    const response = await this.connection().getSignatureStatuses(
      [execution.signature],
      { searchTransactionHistory: true },
    );
    const status = response.value[0];
    if (!status) return;
    if (status.err) {
      this.executions.update(execution, {
        status: "failed",
        slot: status.slot,
        error: JSON.stringify(status.err),
      });
      return;
    }
    const confirmed =
      status.confirmationStatus === "confirmed" ||
      status.confirmationStatus === "finalized" ||
      status.confirmations === null;
    if (!confirmed) return;
    this.executions.update(execution, {
      status: "confirmed",
      slot: status.slot,
      error: null,
    });
    try {
      await this.captureExecutionTradeFill(execution);
    } catch {}
  }

  private tradeWalletAddress(ref: WalletRef): string {
    if (ref instanceof PublicKey) return ref.toBase58();
    if (typeof ref === "string") {
      try {
        return new PublicKey(ref.trim()).toBase58();
      } catch {}
    }
    return this.walletAddress(ref);
  }

  private tradeMint(ref: TokenRef): string {
    if (ref instanceof PublicKey) return ref.toBase58();
    if (typeof ref === "string") {
      try {
        return new PublicKey(ref.trim()).toBase58();
      } catch {}
    }
    return this.resolveToken(ref).mint;
  }

  async recordConfirmedTrade(
    input: RecordConfirmedTradeInput,
  ): Promise<SolardTrade> {
    const signature = input.signature.trim();
    if (!signature) throw new Error("Trade signature is required");
    const walletAddress = this.tradeWalletAddress(input.wallet);
    const mint = this.tradeMint(input.token);
    let execution = this.executions.findBySignature(signature);
    if (execution) {
      if (execution.walletAddress !== walletAddress || execution.mint !== mint)
        throw new Error(
          `Signature ${signature} is already recorded for another trade`,
        );
      const side = executionTradeSide(execution.kind);
      if (side && side !== input.side)
        throw new Error(
          `Signature ${signature} is already recorded as ${side}`,
        );
      this.executions.update(execution, {
        kind: input.side,
        status: "confirmed",
        venue: input.venue ?? execution.venue,
        sender: input.sender ?? execution.sender ?? "external",
        error: null,
      });
    } else {
      execution = this.executions.create({
        signature,
        kind: input.side,
        status: "confirmed",
        walletAddress,
        mint,
        sender: input.sender ?? "external",
        venue: input.venue ?? null,
        slot: null,
        error: null,
        metaJson: JSON.stringify({ externalConfirmed: true }),
      });
    }
    try {
      await this.captureExecutionTradeFill(execution);
    } catch {}
    const trade = executionAsTrade(execution);
    if (!trade) throw new Error(`Could not record trade ${signature}`);
    return trade;
  }

  async trades(options: SolardTradeQuery = {}): Promise<SolardTrade[]> {
    const walletAddress =
      options.wallet == null
        ? undefined
        : this.tradeWalletAddress(options.wallet);
    const mint =
      options.token == null ? undefined : this.tradeMint(options.token);
    const limit =
      options.limit == null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.trunc(options.limit));
    if (limit === 0) return [];
    const rows = this.executions.query({
      walletAddress,
      mint,
    });
    const statuses =
      options.status == null
        ? null
        : new Set<SolardTradeStatus>(
            Array.isArray(options.status)
              ? [...options.status]
              : [options.status],
          );
    const trades: SolardTrade[] = [];
    for (const row of rows) {
      const side = executionTradeSide(row.kind);
      if (!side || (options.side != null && side !== options.side)) continue;
      if (row.status === "submitted") {
        try {
          await this.refreshExecutionTradeStatus(row);
        } catch {}
      }
      if (statuses != null && !statuses.has(row.status)) continue;
      if (row.status === "confirmed" && !storedTradeFill(row)) {
        try {
          await this.captureExecutionTradeFill(row);
        } catch {}
      }
      const trade = executionAsTrade(row);
      if (!trade) continue;
      trades.push(trade);
      if (trades.length >= limit) break;
    }
    return trades;
  }

  connection(): Connection {
    return this.chain.get();
  }

  private async buildJitoTipTransaction(
    payer: PublicKey,
  ): Promise<VersionedTransaction> {
    const signer = this.signer(payer.toBase58());
    const { blockhash } =
      await this.connection().getLatestBlockhash("confirmed");
    const lamports = jitoTipLamports();

    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: randomJitoTipAccount(),
          lamports: Number(lamports),
        }),
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);
    transaction.sign([signer]);
    return transaction;
  }
  registerVenue(plugin: TradeVenuePlugin): this {
    this.venues.register(plugin);
    return this;
  }
  registerClaimSource(plugin: ClaimSourcePlugin): this {
    this.claimSources.register(plugin);
    return this;
  }
  registerLaunchSource(plugin: LaunchSourcePlugin): this {
    this.launches.register(plugin);
    return this;
  }
  registerLaunchpad(plugin: TokenLaunchpadPlugin): this {
    this.launchpads.register(plugin);
    return this;
  }
  registerSender(sender: SolardSender): this {
    this.senders.register(sender);
    return this;
  }

  async getTransaction(
    signatureInput: string,
    options: SolardTransactionOptions = {},
  ): Promise<SolardDecodedTransaction | null> {
    const signature = signatureInput.trim();
    if (!signature) throw new Error("Transaction signature is required");
    const commitment = options.commitment ?? "confirmed";
    if (!options.forceRefresh) {
      const cached = this.db.rawTransactions
        .select()
        .where({ signature })
        .first() as
        | { transactionJson?: string; confidence?: "confirmed" | "finalized" }
        | undefined;
      if (
        cached?.transactionJson &&
        (commitment === "confirmed" || cached.confidence === "finalized")
      ) {
        return decodedTransaction(
          signature,
          deserializeParsedTransaction(cached.transactionJson),
          cached.confidence ?? "confirmed",
        );
      }
    }
    const transaction = await this.connection().getParsedTransaction(
      signature,
      {
        commitment: commitment as Commitment,
        maxSupportedTransactionVersion: 0,
      },
    );
    if (!transaction) return null;
    cacheParsedTransaction({
      database: this.db,
      signature,
      transaction,
      confidence: commitment,
    });
    return decodedTransaction(signature, transaction, commitment);
  }

  async position(options: SolardPositionQuery): Promise<SolardPosition> {
    const walletAddress = this.tradeWalletAddress(options.wallet);
    const mint = this.tradeMint(options.token);
    const connection = this.connection();
    const mintState = await readMint(
      connection,
      new PublicKey(mint),
      this.cache,
    );
    const [amountRaw, solBalance] = await Promise.all([
      readTokenAmount(
        connection,
        new PublicKey(walletAddress),
        new PublicKey(mint),
        mintState.tokenProgram,
      ),
      connection.getBalance(new PublicKey(walletAddress), "confirmed"),
    ]);
    return {
      wallet: walletAddress,
      mint,
      amountRaw,
      decimals: mintState.decimals,
      amountUi: Number(amountRaw) / 10 ** mintState.decimals,
      solLamports: BigInt(solBalance),
      sol: solBalance / 1_000_000_000,
      capturedAtMs: Date.now(),
    };
  }

  createWallet(name?: string): WalletInfo {
    return this.wallets.create(name);
  }
  async createVanityWallet(
    name: string | undefined,
    options: VanityMintOptions,
  ): Promise<{
    wallet: WalletInfo;
    suffix: string;
    attempts: number;
    elapsedMs: number;
    ratePerSecond: number;
    lastMint: string;
  }> {
    const generated = await generateMintKeypairWithSuffix(options);
    const wallet = this.wallets.createFromKeypair(generated.mint, name);
    return {
      wallet,
      suffix: generated.suffix,
      attempts: generated.attempts,
      elapsedMs: generated.elapsedMs,
      ratePerSecond: generated.ratePerSecond,
      lastMint: generated.lastMint,
    };
  }
  importWallet(
    privateKey: string,
    name?: string,
    options?: import("../db/wallet-repo.ts").WalletImportOptions,
  ): WalletInfo {
    return this.wallets.import(privateKey, name, options);
  }
  listWallets(): WalletInfo[] {
    return this.wallets.list();
  }
  walletAddress(ref: WalletRef): string {
    return this.resolveWallet(ref).address.toBase58();
  }
  exportWalletPrivateKey(
    ref: WalletRef,
    format: WalletPrivateKeyFormat = "base58",
  ): WalletPrivateKeyExport {
    const { signer, row } = this.wallets.signer(ref);
    if (!row) throw new Error("Private-key export requires a stored wallet");
    return {
      wallet: {
        id: row.id,
        name: row.name,
        address: row.address,
        isActive: row.isActive,
        createdAtMs: row.createdAtMs,
        updatedAtMs: row.updatedAtMs,
      },
      format,
      privateKey:
        format === "json"
          ? JSON.stringify(Array.from(signer.secretKey))
          : bs58.encode(signer.secretKey),
    };
  }
  resolveWallet(ref: WalletRef) {
    return this.wallets.resolve(ref);
  }
  signer(ref: WalletRef): Keypair {
    return this.wallets.signer(ref).signer;
  }
  wallet(ref: WalletRef) {
    return this.resolveWallet(ref);
  }

  resolveToken(ref: TokenRef): TokenRow {
    return this.tokens.resolve(ref);
  }
  async resolveTokenForExecution(ref: TokenRef): Promise<TokenRow> {
    try {
      return this.resolveToken(ref);
    } catch (error) {
      let mint: string;
      if (ref instanceof PublicKey) {
        mint = ref.toBase58();
      } else if (typeof ref === "string") {
        try {
          mint = new PublicKey(ref.trim()).toBase58();
        } catch {
          throw error;
        }
      } else {
        throw error;
      }

      const existing = this.pendingExecutionTokens.get(mint);
      if (existing) return await existing;

      const pending = this.addToken(mint);
      this.pendingExecutionTokens.set(mint, pending);
      try {
        return await pending;
      } finally {
        if (this.pendingExecutionTokens.get(mint) === pending) {
          this.pendingExecutionTokens.delete(mint);
        }
      }
    }
  }
  token(ref: TokenRef): TokenRow {
    return this.resolveToken(ref);
  }
  async addToken(
    mintRef: string,
    name?: string,
    metadata: Partial<TokenRow> = {},
  ): Promise<TokenRow> {
    return await measured(
      m,
      `add-token ${mintRef.slice(0, 8)}`,
      async () => {
        const mint = new PublicKey(mintRef);
        const chain = this.connection();
        const mintState = await readMint(chain, mint, this.cache);
        const inspected = await this.venues.inspect(chain, mint);
        const candidate = {
          ...inspected, ...metadata, mint: mint.toBase58(),
          metadataJson: mergeTokenMetadataJson(inspected?.metadataJson, metadata.metadataJson),
        };
        const verifiedQuote = await verifyPoolTokenMetadata(chain, candidate);
        return this.tokens.upsert({
          ...candidate,
          ...verifiedQuote,
          name: name ?? metadata.name ?? null,
          decimals: mintState.decimals,
          baseTokenProgram: mintState.tokenProgram.toBase58(),
          refreshedAtMs: Date.now(),
        });
      },
      tokenLog,
    );
  }
  configureToken(ref: TokenRef, patch: Partial<TokenRow>): TokenRow {
    const token = this.resolveToken(ref);
    return this.tokens.upsert({ ...token, ...patch, mint: token.mint });
  }
  async refreshToken(ref: TokenRef): Promise<TokenRow> {
    const token = this.resolveToken(ref);
    const mint = new PublicKey(token.mint);
    const mintState = await readMint(this.connection(), mint, this.cache);
    const inspected = await this.venues.inspect(this.connection(), mint);
    const preservePool = token.pool && (
      token.venueHint === "pumpswap" || token.venueHint === "meteora-damm-v2" ||
      (token.venueHint === "meteora-dbc" && inspected?.venueHint !== "meteora-damm-v2")
    );
    const candidate = {
      ...token, ...inspected, mint: token.mint,
      pool: preservePool ? token.pool : inspected?.pool ?? token.pool,
      venueHint: preservePool ? token.venueHint : inspected?.venueHint ?? token.venueHint,
      metadataJson: mergeTokenMetadataJson(token.metadataJson, inspected?.metadataJson),
    };
    const verifiedQuote = await verifyPoolTokenMetadata(this.connection(), candidate);
    return this.tokens.upsert({
      ...candidate,
      ...verifiedQuote,
      mint: token.mint,
      decimals: mintState.decimals,
      baseTokenProgram: mintState.tokenProgram.toBase58(),
      refreshedAtMs: Date.now(),
    });
  }

  async route(token: TokenRow, user: PublicKey, options: { reserves?: import("../venues/venue-plugin.ts").LivePoolReserves } = {}) {
    return await this.venues.resolve(this.connection(), token, user, options);
  }
  async resolveClaim(token: TokenRow, user: PublicKey): Promise<ClaimPlan> {
    return (await this.claimSources.resolve(this.connection(), token, user))
      .plan;
  }
  /** Read-only discovery uses the public wallet identity, never a signer. */
  async walletLedger(wallet: WalletRef, options: WalletLedgerOptions = {}) {
    return await loadWalletLedger(createRawTransactionCachingConnection({ connection: this.connection(), database: this.db }), this.wallets.resolve(wallet).address, options);
  }
  async historicalTape(token: TokenRef, options: TokenBacktestTapeOptions & MarketHistoryOptions = {}) {
    await this.marketHistory(token, options);
    const resolved = await this.resolveReplayToken(token);
    return loadHistoricalTradeTape(resolved.mint, options, new SqliteTokenHistoryRepository(this.db));
  }
  async resolveCurrentMarket(token: TokenRef, options: { pool?: string | PublicKey } = {}) {
    const resolved = await this.resolveReplayToken(token);
    if (options.pool) return await loadCurrentMarket(this.connection(), resolved.mint, options);
    if (resolved.pool) {
      const known = await loadCurrentMarket(this.connection(), resolved.mint, {pool: resolved.pool});
      if (known) return known;
    }
    return await loadCurrentMarket(this.connection(), resolved.mint);
  }
  async getClaimableCreatorFees(wallet: WalletRef, options: { tokens?: readonly TokenRef[] } = {}) {
    const address = this.wallets.resolve(wallet).address;
    const tokens = options.tokens ? await Promise.all(options.tokens.map((ref) => this.resolveTokenForExecution(ref))) : this.tokens.list();
    return await discoverCreatorFees(this.connection(), address, tokens, this.claimSources.list());
  }

  async claimAllCreatorFees(wallet: WalletRef, options: TradeExecutionOptions & { tokens?: readonly TokenRef[]; maxInstructions?: number } = {}) {
    const discovery = await this.getClaimableCreatorFees(wallet, options);
    const batches = batchCreatorFeePlans(discovery.plans, options.maxInstructions ?? 12);
    const receipts: Array<{ sources: Array<string>; result: TradeResult; payout: WalletLedgerEntry | null }> = [];
    for (let index = 0; index < batches.length; index++) {
      const claims = batches[index]!;
      const draft: TransactionDraft = { instructions: claims.flatMap((claim) => claim.instructions), signers: [], trackedAccounts: [{ address: this.signer(wallet).publicKey, kind: "sol" }],
        actions: claims.map((claim) => ({ kind: "creator-claim", meta: { source: claim.source, quoteMint: claim.quoteAsset.mint.toBase58(), estimatedClaimRaw: claim.estimatedClaimRaw.toString(), ...(claim.meta ?? {}) } })) };
      const intentKey = options.intentKey ? `${options.intentKey}:claim:${index}` : undefined;
      const result = await this.runReliableTrade(wallet, intentKey, JSON.stringify(draft.actions), async () => {
        const execution = await this.executeTradePlan(wallet, () => this.compile(this.signer(wallet), draft),
          options.landing?.route ?? (Array.isArray(options.via) ? options.via[0] : options.via) ?? "rpc", "claim", { ...options, intentKey });
        return tradeResult(execution.receipt, execution.attempts, execution.submission.executionId);
      });
      let payout: WalletLedgerEntry | null = null;
      if (result.status === "confirmed" && result.signature) {
        try {
          const transaction = await this.connection().getParsedTransaction(result.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
          if (transaction) payout = walletLedgerEntry(transaction, this.wallets.resolve(wallet).address, result.signature);
        } catch { /* Payout stays unknown if confirmed metadata is unavailable. */ }
      }
      receipts.push({ sources: claims.map((claim) => claim.source), result, payout });
      if (result.status === "unresolved") break;
    }
    return { discovery, receipts, complete: receipts.length === batches.length && receipts.every((row) => row.result.status !== "unresolved") };
  }
  async waitForLaunch(
    sourceId: string,
    args: WaitForLaunchArgs,
  ): Promise<DiscoveredLaunch> {
    return await this.launches.wait(this.connection(), sourceId, args);
  }
  async persistLaunch(
    launch: DiscoveredLaunch,
    alias?: string,
  ): Promise<TokenRow> {
    const token = this.tokens.upsert({
      ...launch.token,
      name: alias ?? launch.name ?? launch.token.name ?? null,
      mint: launch.mint.toBase58(),
      refreshedAtMs: Date.now(),
    });
    return await this.refreshToken(token);
  }
  async prepareTokenDeployment(
    launchpadId: string,
    wallet: WalletRef,
    args: Omit<PrepareDeploymentArgs, "user"> & { vanitySuffix?: string; creatorBuySol?: HumanAmount },
  ): Promise<PreparedTokenDeployment> {
    const user = this.signer(wallet).publicKey;
    if (args.vanitySuffix && args.mint) throw new Error("Choose a mint or a vanity suffix, not both");
    const reserved = args.vanitySuffix ? reserveVanityMintFromPool(args.vanitySuffix, { reason: `deployment:${launchpadId}` }, this.db) : null;
    try {
      if (args.creatorBuySol && args.initialBuy) throw new Error("Choose creatorBuySol or initialBuy");
      const budget = args.creatorBuySol ? toRawAmount(args.creatorBuySol) : null;
      if (budget && (!sameAsset(budget.asset, SOL_ASSET) || budget.raw <= 0n)) throw new Error("creatorBuySol requires a positive SOL budget");
      const plugin = this.launchpads.resolve(launchpadId);
      let deployment = await plugin.prepareDeployment(this.connection(), { ...args, mint: reserved?.mint ?? args.mint, user });
      if (budget) {
        if (deployment.quoteAsset.kind === "native-sol") {
          deployment = await plugin.prepareDeployment(this.connection(), { ...args, mint: deployment.mint, initialBuy: budget, user });
        } else {
          const total = args.slippageBps ?? 500;
          if (!Number.isSafeInteger(total) || total < 0 || total >= 10_000) throw new Error("Invalid slippageBps");
          const leg = Math.floor((1 - Math.sqrt(1 - total / 10_000)) * 10_000);
          const funding = await this.tx(wallet).buy(deployment.quoteAsset.mint, budget, { slippageBps: leg }).materializedDraft();
          const action = funding.actions.find((item) => item.kind === "buy");
          const minimum = BigInt(String(action?.meta?.minOutputRaw ?? "0"));
          if (minimum <= 0n) throw new Error("Quote funding route has no guaranteed output");
          const state = await this.initialPendingMarketState(launchpadId, deployment);
          const buy = await this.preparePendingBuy(launchpadId, deployment, wallet, rawAmount(minimum, deployment.quoteAsset), state, { slippageBps: leg });
          deployment.instructions.push(...funding.instructions, ...buy.instructions);
          deployment.signers.push(...funding.signers);
          deployment.metadata = { ...deployment.metadata, fundingActions: funding.actions, initialBuyRaw: minimum.toString(), minimumOutputRaw: buy.minimumOutputRaw.toString(), expectedOutputRaw: buy.expectedOutputRaw.toString() };
        }
        deployment.metadata = { ...deployment.metadata, creatorBuySolLamports: budget.raw.toString() };
      }
      if (reserved) deployment.metadata = { ...deployment.metadata, vanityMintPoolAddress: reserved.address };
      return deployment;
    } catch (error) {
      if (reserved) releaseVanityMintReservation(reserved.address, this.db);
      throw error instanceof TradePreSubmissionError ? error : new TradePreSubmissionError(error);
    }
  }
  getSupportedPumpPairs() { return loadPumpPairs(this.connection()); }
  listVanityMints(options: Parameters<typeof listVanityMintPool>[0] = {}) { return listVanityMintPool(options, this.db); }
  releaseVanityMint(address: string) { return releaseVanityMintReservation(address, this.db); }
  async initialPendingMarketState(
    launchpadId: string,
    deployment: PreparedTokenDeployment,
  ): Promise<PendingMarketState> {
    const plugin = this.launchpads.resolve(launchpadId);
    if (!plugin.initialPendingMarketState)
      throw new Error(
        `Launchpad ${launchpadId} does not support pre-landing buys`,
      );
    return await plugin.initialPendingMarketState(
      this.connection(),
      deployment,
    );
  }
  async preparePendingBuy(
    launchpadId: string,
    deployment: PreparedTokenDeployment,
    buyer: WalletRef,
    amount: import("../core/amounts.ts").RawAmount,
    state: PendingMarketState,
    options: { slippageBps?: number } = {},
  ): Promise<PreparedPendingBuy> {
    const plugin = this.launchpads.resolve(launchpadId);
    if (!plugin.buildPendingBuy)
      throw new Error(
        `Launchpad ${launchpadId} does not support pre-landing buys`,
      );
    return await plugin.buildPendingBuy(
      this.connection(),
      deployment,
      this.signer(buyer).publicKey,
      amount,
      state,
      options,
    );
  }
  persistPreparedDeployment(
    deployment: PreparedTokenDeployment,
    alias?: string,
  ): TokenRow {
    return this.tokens.upsert({
      ...deployment.token,
      name: alias ?? deployment.token.name ?? null,
      mint: deployment.mint.publicKey.toBase58(),
      refreshedAtMs: Date.now(),
    });
  }
  async deployToken(
    launchpadId: string,
    wallet: WalletRef,
    args: Omit<PrepareDeploymentArgs, "user"> & { vanitySuffix?: string; creatorBuySol?: HumanAmount },
    options: TradeExecutionOptions & { alias?: string } = {},
  ): Promise<{
    deployment: PreparedTokenDeployment;
    token: TokenRow | null;
    receipt: SendReceipt;
    result: TradeResult;
    costs: { networkFeeLamports: bigint | null; tipLamports: bigint | null; tokenAccountRentDeltaLamports: bigint | null; creatorBuyBudgetLamports: bigint | null; solDeltaLamports: bigint | null; residualLamports: bigint | null; targetTokenDeltaRaw: bigint | null };
  }> {
    if (options.intentKey) throw new TradePreSubmissionError(Object.assign(new Error("Launch intent keys require a persisted prepared deployment and are not supported by deployToken yet"), { code: "UNSUPPORTED_LAUNCH_INTENT" }));
    const deployment = await this.prepareTokenDeployment(
      launchpadId,
      wallet,
      args,
    );
    const build = () => {
      const builder = this.transaction(wallet)
      .addMany(deployment.instructions, {
        kind: "deploy-token",
        mint: deployment.mint.publicKey,
        meta: { launchpad: launchpadId, name: args.name, symbol: args.symbol },
      });
      for (const signer of deployment.signers) builder.withSigner(signer);
      return builder.build();
    };
    const execution = await this.executeTradePlan(wallet, build, options.landing?.route ?? (Array.isArray(options.via) ? options.via[0] : options.via) ?? "rpc", "deploy-token", options);
    const receipt = execution.receipt;
    if (receipt.status === "confirmed" && deployment.metadata?.vanityMintPoolAddress) markVanityMintUsed(String(deployment.metadata.vanityMintPoolAddress), this.db);
    const result = tradeResult(receipt, execution.attempts, execution.submission.executionId);
    let ledger: WalletLedgerEntry | null = null;
    if (receipt.status !== "submitted") {
      try {
        const transaction = await this.connection().getParsedTransaction(receipt.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
        if (transaction) ledger = walletLedgerEntry(transaction, deployment.user, receipt.signature);
      } catch { /* Confirmed accounting remains unavailable when RPC metadata is unavailable. */ }
    }
    const costs = { networkFeeLamports: ledger?.networkFeeLamports ?? result.networkFeeLamports,
      tipLamports: ledger?.tipLamports ?? null, tokenAccountRentDeltaLamports: ledger?.components.tokenAccountRent ?? null,
      creatorBuyBudgetLamports: deployment.metadata?.creatorBuySolLamports == null ? null : BigInt(String(deployment.metadata.creatorBuySolLamports)),
      solDeltaLamports: ledger?.solDeltaLamports ?? null, residualLamports: ledger?.components.residual ?? null,
      targetTokenDeltaRaw: ledger?.tokenDeltas.find(delta => delta.mint === deployment.mint.publicKey.toBase58())?.deltaRaw ?? null };
    const token = receipt.status === "confirmed" ? this.persistPreparedDeployment(deployment, options.alias) : null;
    return { deployment, token, receipt, result, costs };
  }
  groupWallets(name: GroupRef): WalletRef[] {
    const groupName = String(name).trim();

    if (groupName.toLowerCase() === "ungrouped") {
      // "ungrouped" is a virtual group: active registry wallets that belong
      // to zero persisted groups. Ignore any legacy/accidental persisted
      // membership whose groupName itself is "ungrouped".
      const groupedAddresses = new Set(
        (
          this.db.groupWallets.select().all() as Array<{
            groupName: string;
            walletAddress: string;
          }>
        )
          .filter((row) => row.groupName.trim().toLowerCase() !== "ungrouped")
          .map((row) => row.walletAddress),
      );

      const refs = this.wallets
        .list()
        .filter((wallet) => !groupedAddresses.has(wallet.address))
        .map((wallet) => wallet.address);

      if (!refs.length) throw new Error("Group has no wallets: ungrouped");
      return refs;
    }

    const memberships = this.groups.wallets(groupName);
    if (!memberships.length)
      throw new Error(`Group has no wallets: ${groupName}`);
    return memberships.map((row) => row.walletAddress);
  }
  async tokenAccounts(ref: WalletRef): Promise<OwnedTokenAccount[]> {
    const wallet = this.resolveWallet(ref);
    return await listOwnedTokenAccounts(this.connection(), wallet.address);
  }

  async tokenBalance(
    owner: PublicKey,
    token: TokenRow,
    tokenProgram: PublicKey,
  ): Promise<bigint> {
    return await readTokenAmount(
      this.connection(),
      owner,
      new PublicKey(token.mint),
      tokenProgram,
    );
  }

  async walletBalances(
    ref: WalletRef,
    tokenRefs: TokenRef[] = this.tokens.list(),
  ): Promise<{
    wallet: { name: string | null; address: string };
    solLamports: bigint;
    tokenBalances: Array<{
      token: TokenRow;
      amountRaw: bigint;
      decimals: number;
    }>;
    capturedAtMs: number;
  }> {
    const wallet = this.resolveWallet(ref);
    const connection = this.connection();
    const solLamports = BigInt(
      await connection.getBalance(wallet.address, "confirmed"),
    );
    const tokenBalances = await Promise.all(
      tokenRefs.map(async (tokenRef) => {
        const token = this.resolveToken(tokenRef);
        const storedDecimals = optionalDecimals(
          (token as TokenRow & { decimals: unknown }).decimals,
        );
        const mintState =
          token.baseTokenProgram && storedDecimals != null
            ? {
                tokenProgram: new PublicKey(token.baseTokenProgram),
                decimals: storedDecimals,
              }
            : await readMint(connection, new PublicKey(token.mint), this.cache);
        if (
          typeof (token as TokenRow & { decimals: unknown }).decimals !==
          "number"
        ) {
          this.tokens.upsert({
            mint: token.mint,
            decimals: mintState.decimals,
          });
        }
        const amountRaw = await this.tokenBalance(
          wallet.address,
          token,
          mintState.tokenProgram,
        );
        this.positions.recordBalance({
          walletAddress: wallet.address.toBase58(),
          mint: token.mint,
          amountRaw,
          decimals: mintState.decimals,
        });
        return {
          token: { ...token, decimals: mintState.decimals },
          amountRaw,
          decimals: mintState.decimals,
        };
      }),
    );
    return {
      wallet: {
        name: wallet.row?.name ?? null,
        address: wallet.address.toBase58(),
      },
      solLamports,
      tokenBalances,
      capturedAtMs: Date.now(),
    };
  }

  async quoteBuy(ref: TokenRef, amount: HumanAmount, slippageBps = 1500) {
    const token = this.resolveToken(ref);
    const user = PublicKey.default;
    const { plugin, market } = await this.route(token, user);
    const input = toRawAmount(amount);
    if (!sameAsset(input.asset, market.quoteAsset)) {
      throw new QuoteAssetMismatchError(
        input.asset.mint.toBase58(),
        market.quoteAsset.mint.toBase58(),
      );
    }
    const quote = await plugin.quoteBuy(
      { connection: this.connection(), token, user },
      market,
      input,
      slippageBps,
    );
    return { token, venue: market.venue, quoteAsset: market.quoteAsset, quote };
  }

  async samplePrice(ref: TokenRef): Promise<MarketPrice> {
    const token = this.resolveToken(ref);
    const { plugin, market } = await this.route(token, PublicKey.default);
    const sampled = await plugin.price(
      { connection: this.connection(), token, user: PublicKey.default },
      market,
    );
    this.prices.record({
      mint: token.mint,
      venue: sampled.venue,
      quoteMint: sampled.quoteAsset.mint.toBase58(),
      quoteKind: sampled.quoteAsset.kind,
      priceQuotePerToken: sampled.priceQuotePerToken,
      baseReserveRaw: sampled.baseReserveRaw?.toString() ?? null,
      quoteReserveRaw: sampled.quoteReserveRaw?.toString() ?? null,
      capturedAtMs: sampled.capturedAtMs,
    });
    return sampled;
  }

  averagePrice(ref: TokenRef, periodMs: number): PriceWindow {
    if (!Number.isFinite(periodMs) || periodMs <= 0)
      throw new Error("Price average period must be greater than zero");
    const token = this.resolveToken(ref);
    return this.prices.average(token.mint, periodMs);
  }

  async *watchPrices(
    refs: TokenRef[],
    options: {
      intervalMs?: number;
      averagePeriodMs?: number;
      signal?: AbortSignal;
    } = {},
  ): AsyncGenerator<{
    token: TokenRow;
    sample: MarketPrice;
    average: PriceWindow;
  }> {
    if (refs.length === 0)
      throw new Error("watchPrices requires at least one token");
    const intervalMs = options.intervalMs ?? 1_000;
    const averagePeriodMs = options.averagePeriodMs ?? 60_000;
    if (!Number.isFinite(intervalMs) || intervalMs < 250)
      throw new Error("Price interval must be at least 250ms");
    const tokens = refs.map((ref) => this.resolveToken(ref));
    while (!options.signal?.aborted) {
      for (const token of tokens) {
        const sample = await this.samplePrice(token);
        yield {
          token,
          sample,
          average: this.prices.average(token.mint, averagePeriodMs),
        };
      }
      if (!options.signal?.aborted)
        await sleep(intervalMs, undefined, { signal: options.signal }).catch(
          (error) => {
            if (!options.signal?.aborted) throw error;
          },
        );
    }
  }

  transaction(wallet: WalletRef): TransactionBuilder {
    return new TransactionBuilder(this, wallet);
  }
  tx(wallet: WalletRef): TransactionComposer {
    return new TransactionComposer(this, wallet);
  }
  composeMany(wallets: WalletRef[]): BatchComposer {
    return new BatchComposer(this, wallets);
  }
  group(name: GroupRef): SolardGroup {
    return new SolardGroup(
      this,
      name,
      this.groupWallets(name).map((ref) => String(ref)),
    );
  }

  async compile(
    payer: Keypair,
    draft: TransactionDraft,
    options: { useAlts?: boolean } = {},
  ): Promise<PlannedTransaction> {
    return await assembleTransaction({
      connection: this.connection(),
      blockhash: this.blockhash,
      payer,
      draft,
      altAddresses:
        options.useAlts === false
          ? []
          : this.alts.list().map((row) => new PublicKey(row.address)),
    });
  }

  /** Optional warmup; stop the timer when the worker shuts down. */
  warmBlockhash(options: { intervalMs?: number } = {}) {
    return this.blockhash.start(this.connection(), options);
  }
  async simulatePlan(plan: PlannedTransaction): Promise<SimulationResult> {
    return await simulatePlanned(this.connection(), plan);
  }
  async simulate(
    tx: SolardTransaction,
    wallet: WalletRef,
  ): Promise<SimulationResult> {
    return await this.simulatePlan(
      await this.compile(this.signer(wallet), tx.snapshot()),
    );
  }
  async send(
    tx: SolardTransaction,
    options: {
      wallet: WalletRef;
      via?: SenderId;
      kind?: string;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    },
  ): Promise<SendReceipt> {
    return await this.sendPlan(
      await this.compile(this.signer(options.wallet), tx.snapshot()),
      options.via ?? "rpc",
      options.kind,
      options,
    );
  }
  async submit(
    tx: SolardTransaction,
    options: {
      wallet: WalletRef;
      via?: SenderId;
      kind?: string;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    },
  ): Promise<SubmittedPlan> {
    return await this.submitPlan(
      await this.compile(this.signer(options.wallet), tx.snapshot()),
      options.via ?? "rpc",
      options.kind,
      options,
    );
  }
  async sendBatchPlans(
    plans: PlannedTransaction[],
    via: SenderId,
    kind = "batch",
    options: SendOptions = {},
  ): Promise<BatchSendReceipt> {
    if (plans.length === 0)
      throw new Error("Cannot send an empty transaction batch");
    const sender = this.senders.resolve(via);
    if (!isBundleSender(sender) || plans.length === 1) {
      return {
        sender: String(via),
        mode: "parallel",
        receipts: await Promise.all(
          plans.map((plan) => this.sendPlan(plan, via, kind, options)),
        ),
      };
    }

    const simulations = options.skipSimulation
      ? []
      : await Promise.all(plans.map((plan) => this.simulatePlan(plan)));
    const failed = simulations.find((simulation) => !simulation.success);
    if (failed)
      throw new Error(
        `Batch simulation failed: ${JSON.stringify(failed.error)}\n${failed.diagnostics?.message ?? ""}\n${failed.logs.join("\n")}`,
      );

    const records = plans.map((plan, index) =>
      this.executions.create(
        {
          signature: null,
          kind,
          status: options.skipSimulation ? "planned" : "simulated",
          walletAddress: plan.payer.toBase58(),
          mint:
            plan.draft.actions
              .find((action) => action.mint)
              ?.mint?.toBase58() ?? null,
          sender: String(via),
          venue: null,
          slot: null,
          error: null,
          metaJson: JSON.stringify({
            batchIndex: index,
            serializedSize: plan.serializedSize,
            simulation: simulations[index] ?? null,
            skipSimulation: options.skipSimulation === true,
          }),
        },
        plan.draft.actions,
      ),
    );

    try {
      const submissionIds: string[] = [];
      const signatures: string[] = [];
      const isJitoBundle = String(via) === "jito";
      const hasEmbeddedJitoTip = plans.some((plan) =>
        plan.draft.actions.some((action) => action.kind === "jito-tip"),
      );
      const chunkSize =
        isJitoBundle && !hasEmbeddedJitoTip
          ? BUNDLE_TRANSACTION_LIMIT - 1
          : BUNDLE_TRANSACTION_LIMIT;

      for (const chunk of chunkPlans(plans, chunkSize)) {
        const transactions = chunk.map((plan) => plan.transaction);

        if (isJitoBundle) {
          const chunkHasEmbeddedTip = chunk.some((plan) =>
            plan.draft.actions.some((action) => action.kind === "jito-tip"),
          );
          const bundleTransactions = chunkHasEmbeddedTip
            ? transactions
            : [
                await this.buildJitoTipTransaction(chunk[0]!.payer),
                ...transactions,
              ];
          const submission = await sender.sendBundle({
            connection: this.connection(),
            transactions: bundleTransactions,
          });
          submissionIds.push(submission.submissionId);
          signatures.push(
            ...submission.signatures.slice(chunkHasEmbeddedTip ? 0 : 1),
          );
        } else {
          const submission = await sender.sendBundle({
            connection: this.connection(),
            transactions,
          });
          submissionIds.push(submission.submissionId);
          signatures.push(...submission.signatures);
        }
      }
      const receipts =
        isJitoBundle && sender instanceof JitoSender
          ? await (async (): Promise<SendReceipt[]> => {
              if (submissionIds.length !== 1) {
                throw new Error(
                  `Expected one Jito bundle submission, got ${submissionIds.length}`,
                );
              }
              const landing = await sender.waitForBundle(submissionIds[0]!);
              if (landing.status === "expired") {
                throw new JitoBundleExpiredError(
                  landing.detail ??
                    `Jito bundle ${submissionIds[0]} exhausted its blockhash`,
                );
              }
              if (landing.status === "retry") {
                throw new JitoBundleGenerationRetryError(
                  landing.detail ??
                    `Jito bundle ${submissionIds[0]} needs a fresh tip generation`,
                );
              }
              if (landing.status !== "landed") {
                throw new Error(
                  landing.detail ??
                    `Jito bundle ${submissionIds[0]} ended with ${landing.status}`,
                );
              }
              return signatures.map((signature) => ({
                signature,
                slot: landing.slot,
                sender: String(via),
                status: "confirmed" as const,
              }));
            })()
          : await Promise.all(
              signatures.map((signature) =>
                confirmSignature(this.connection(), signature, String(via)),
              ),
            );
      receipts.forEach((receipt, index) =>
        this.executions.update(records[index]!, {
          signature: receipt.signature,
          status: receipt.status,
          slot: receipt.slot,
          error: receipt.error ?? null,
        }),
      );
      return {
        sender: String(via),
        mode: "bundle",
        submissionId: submissionIds.join(","),
        receipts,
      };
    } catch (error) {
      const retryGeneration =
        isJitoBundleExpiredError(error) ||
        isJitoBundleGenerationRetryError(error);
      for (const record of records)
        this.executions.update(record, {
          status: retryGeneration ? "planned" : "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      throw error;
    }
  }

  async submitPlan(
    plan: PlannedTransaction,
    via: SenderId,
    kind = "transaction",
    options: SendOptions & { intentKey?: string; fallbackSenders?: SenderId[]; onSubmitted?: (signature: string) => void; onRebroadcast?: (signature: string) => void } = {},
  ): Promise<SubmittedPlan> {
    try { await checkPlanBalance(this.connection(), plan); }
    catch (error) { throw error instanceof TradePreSubmissionError ? error : new TradePreSubmissionError(error); }
    let simulation: SimulationResult | null = null;
    if (!options.skipSimulation) {
      simulation = await measured(
        m,
        `preflight ${via}`,
        async () => {
          const result = await this.simulatePlan(plan);
          if (!result.success)
            throw new TradePreSubmissionError(new Error(
              `Simulation failed: ${JSON.stringify(result.error)}\n${result.diagnostics?.message ?? ""}\n${result.logs.join("\n")}`,
            ));
          return result;
        },
        simulationLog,
      );
    }
    const signature = signedPlanSignature(plan);
    const feeEstimate = await estimatePlanFee(this.connection(), plan);
    let execution = this.executions.findBySignature(signature);
    if (!execution) {
      execution = this.executions.create(
        {
          signature,
          kind,
          status: "submitted",
          walletAddress: plan.payer.toBase58(),
          mint:
            plan.draft.actions.find((a) => a.mint)?.mint?.toBase58() ?? null,
          sender: String(via),
          venue: null,
          slot: null,
          error: null,
          metaJson: JSON.stringify({
            serializedSize: plan.serializedSize,
            simulation,
            skipSimulation: options.skipSimulation === true,
            feeEstimate,
            recentBlockhash: plan.recentBlockhash,
            lastValidBlockHeight: plan.lastValidBlockHeight,
            signedTransactionBase64: Buffer.from(plan.transaction.serialize()).toString("base64"),
            landingTipLamports: plan.draft.actions.filter((action) => action.kind === "landing-tip").reduce((total, action) => total + Number(action.meta?.lamports ?? 0), 0),
          }),
        },
        plan.draft.actions,
      );
    } else {
      this.executions.update(execution, {
        kind,
        status: "submitted",
        sender: String(via),
        error: null,
      });
    }
    const submission: SubmittedPlan = {
      signature,
      sender: String(via),
      executionId: execution.id,
      plan,
      onRebroadcast: options.onRebroadcast,
      fallbackSenders: options.fallbackSenders,
      feeEstimate,
    };
    if (options.intentKey) new TradeIntentStore(this.db).update(options.intentKey, (intent) => {
      if (!intent.submissions.some((row) => row.signature === signature))
        intent.submissions.push({ signature, executionId: execution!.id, sender: String(via), lastValidBlockHeight: plan.lastValidBlockHeight, priorityMicroLamports: plan.draft.cuPriceMicroLamports ?? 0 });
    });
    return await measured(
      m,
      `submit ${via}`,
      async () => {
        const broadcast = async (skipPreflight: boolean) => {
          const returned = await this.senders.resolve(via).send({
            connection: this.connection(),
            transaction: plan.transaction,
            options: {
              ...options,
              skipPreflight,
            },
          });
          if (returned !== signature)
            throw new Error(
              `${String(via)} returned signature ${returned}, expected signed transaction ${signature}`,
            );
        };
        try {
          await broadcast(options.skipPreflight ?? true);
          notifyTrade(() => options.onSubmitted?.(signature));
          return submission;
        } catch (error) {
          if (definitiveSubmissionFailure(error)) {
            this.executions.update(execution!, {
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
          if (await waitForSignatureSeen(this.connection(), signature))
            return submission;
          for (const sender of options.fallbackSenders ?? []) {
            try {
              const returned = await this.senders.resolve(sender).send({ connection: this.connection(), transaction: plan.transaction, options: { ...options, skipPreflight: true } });
              if (returned !== signature) throw new Error("Fallback sender returned a different signature");
              notifyTrade(() => options.onRebroadcast?.(signature));
              return submission;
            } catch { /* Same signed bytes only; sender failure leaves original uncertain. */ }
          }
          if (String(via) !== "rpc") {
            this.executions.update(execution!, {
              error: error instanceof Error ? error.message : String(error),
            });
            return submission;
          }
          let lastError: unknown = error;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              await broadcast(true);
              notifyTrade(() => options.onRebroadcast?.(signature));
              return submission;
            } catch (rebroadcastError) {
              lastError = rebroadcastError;
              if (await waitForSignatureSeen(this.connection(), signature))
                return submission;
            }
          }
          this.executions.update(execution!, {
            error:
              lastError instanceof Error
                ? lastError.message
                : String(lastError),
          });
          return submission;
        }
      },
      submittedPlanLog,
    );
  }

  async confirmSignature(
    signature: string,
    sender: SenderId | string = "rpc",
    timeoutMs = 30_000,
  ): Promise<SendReceipt> {
    const receipt = await confirmSignature(
      this.connection(),
      signature,
      String(sender),
      timeoutMs,
    );
    const execution = this.executions.findBySignature(signature);
    if (execution) {
      this.executions.update(execution, {
        status: receipt.status,
        slot: receipt.slot,
        error: receipt.error ?? null,
      });
      if (receipt.status === "confirmed") {
        try {
          await this.captureExecutionTradeFill(execution);
        } catch {}
      }
    }
    return receipt;
  }

  async confirmSubmission(
    submission: SubmittedPlan,
    timeoutMs = 30_000,
    rebroadcast = true,
  ): Promise<SendReceipt> {
    const execution = this.executions.get(submission.executionId);
    if (
      rebroadcast && submission.sender === "rpc" &&
      !(await waitForSignatureSeen(this.connection(), submission.signature)) &&
      await this.connection().getBlockHeight("confirmed") <= submission.plan.lastValidBlockHeight
    ) {
      try {
        const returned = await this.senders.resolve("rpc").send({
          connection: this.connection(),
          transaction: submission.plan.transaction,
          options: { skipPreflight: true, skipSimulation: true },
        });
        if (returned !== submission.signature)
          throw new Error(
            `rpc rebroadcast returned signature ${returned}, expected ${submission.signature}`,
          );
        notifyTrade(() => submission.onRebroadcast?.(submission.signature));
      } catch (error) {
        this.executions.update(execution, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const receipt = await confirmSignature(
      this.connection(),
      submission.signature,
      submission.sender,
      timeoutMs,
    );
    this.executions.update(execution, {
      status: receipt.status,
      slot: receipt.slot,
      error: receipt.error ?? null,
    });
    if (receipt.status === "confirmed") {
      try {
        await this.captureExecutionTradeFill(execution);
      } catch {}
      const trackedMints = new Set(
        submission.plan.draft.actions
          .map((row) => row.mint?.toBase58())
          .filter((mint): mint is string => Boolean(mint)),
      );
      for (const mint of trackedMints) {
        try {
          const token = this.tokens.resolve(mint);
          const storedDecimals = optionalDecimals(
            (token as TokenRow & { decimals: unknown }).decimals,
          );
          const mintState =
            token.baseTokenProgram && storedDecimals != null
              ? {
                  tokenProgram: new PublicKey(token.baseTokenProgram),
                  decimals: storedDecimals,
                }
              : await readMint(
                  this.connection(),
                  new PublicKey(token.mint),
                  this.cache,
                );
          const balance = await this.tokenBalance(
            submission.plan.payer,
            token,
            mintState.tokenProgram,
          );
          this.positions.recordBalance({
            walletAddress: submission.plan.payer.toBase58(),
            mint,
            amountRaw: balance,
            decimals: mintState.decimals,
          });
          this.positions.upsert({
            walletAddress: submission.plan.payer.toBase58(),
            mint,
            tokenAmountRaw: balance,
            quoteMint: token.quoteMint ?? undefined,
          });
        } catch {}
      }
      for (const action of submission.plan.draft.actions.filter(
        (row) => row.kind === "claim",
      )) {
        const meta = action.meta ?? {};
        this.db.claims.insert({
          walletAddress: submission.plan.payer.toBase58(),
          mint: action.mint?.toBase58() ?? "",
          quoteMint: String(meta.quoteMint ?? ""),
          path: String(meta.path ?? "venue"),
          estimatedClaimRaw: String(meta.estimatedClaimRaw ?? "0"),
          claimedRaw: null,
          signature: receipt.signature,
          status: "confirmed",
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        });
      }
    }
    return { ...receipt, feeEstimate: submission.feeEstimate };
  }

  async settleSubmission(
    submission: SubmittedPlan,
    confirmationSliceMs = 1_000,
    settlementTimeoutMs = 180_000,
    resendIntervalMs = 1_500,
  ): Promise<SendReceipt> {
    const sliceMs = Math.max(1_000, Math.trunc(confirmationSliceMs));
    if (!Number.isFinite(settlementTimeoutMs) || settlementTimeoutMs < 1_000)
      throw new Error("settlementTimeoutMs must be at least 1000");
    if (!Number.isFinite(resendIntervalMs) || resendIntervalMs < 1_000)
      throw new Error("resendIntervalMs must be at least 1000");
    const deadline = Date.now() + settlementTimeoutMs;
    let nextResend = Date.now() + resendIntervalMs;
    while (Date.now() < deadline) {
      let receipt: SendReceipt;
      try {
        receipt = await this.confirmSubmission(submission, sliceMs, false);
      } catch {
        // An unavailable RPC is not evidence that a trade failed.
        await sleep(500);
        continue;
      }
      if (receipt.status !== "submitted") return receipt;

      let blockHeight: number | null = null;
      try {
        blockHeight = await this.connection().getBlockHeight("confirmed");
      } catch {}
      if (blockHeight == null) {
        await sleep(500);
        continue;
      }
      if (blockHeight <= submission.plan.lastValidBlockHeight) {
        if (Date.now() >= nextResend) {
          nextResend = Date.now() + resendIntervalMs;
          const senders = new Set([submission.sender, ...(submission.fallbackSenders ?? []), "rpc"]);
          await Promise.allSettled([...senders].map(async (sender) => {
            const returned = await this.senders.resolve(sender).send({ connection: this.connection(),
              transaction: submission.plan.transaction, options: { skipPreflight: true, skipSimulation: true } });
            if (returned !== submission.signature) throw new Error("Rebroadcast signature mismatch");
            notifyTrade(() => submission.onRebroadcast?.(submission.signature));
          }));
        }
        continue;
      }

      const expiry = await inspectExpiredSubmission(
        this.connection(), submission.signature, submission.plan.lastValidBlockHeight,
      );
      if (expiry !== "expired-unobserved") {
        await sleep(500);
        continue;
      }

      const error =
        `Transaction ${submission.signature} expired before confirmation at block height ` +
        `${blockHeight}; last valid block height was ${submission.plan.lastValidBlockHeight}.`;
      const execution = this.executions.get(submission.executionId);
      this.executions.update(execution, {
        status: "failed",
        slot: null,
        error,
      });
      return {
        signature: submission.signature,
        slot: null,
        sender: submission.sender,
        status: "failed",
        retryable: true,
        error,
      };
    }
    const error = `Transaction ${submission.signature} settlement timed out; reconciliation required. Do not repeat this trade until its outcome is known.`;
    this.executions.update(this.executions.get(submission.executionId), {
      status: "submitted", error,
    });
    return { signature: submission.signature, slot: null, sender: submission.sender,
      status: "submitted", retryable: false, error };
  }

  async sendPlan(
    plan: PlannedTransaction,
    via: SenderId,
    kind = "transaction",
    options: SendOptions = {},
  ): Promise<SendReceipt> {
    const submission = await this.submitPlan(plan, via, kind, options);
    return await this.confirmSubmission(submission);
  }

  /** Apply the same fee policy for simulation and live trade construction. */
  async prepareTradePlan(wallet: WalletRef, draftPlan: PlannedTransaction,
    options: TradeExecutionOptions = {}, previousFee?: number) {
    const policy = normalizeLandingPolicy({ ...options.landing, microLamports: options.priorityFee?.microLamports ?? options.landing?.microLamports });
    const tier = options.heliusTier ?? (policy.route === "helius-swqos" || policy.route === "helius-max" ? policy.route : undefined);
    if (tier) draftPlan = { ...draftPlan, draft: addHeliusLandingTip(draftPlan.draft, draftPlan.payer, tier).draft };
    let computeLimit = options.priorityFee?.cuLimit ?? (typeof options.landing?.cuLimit === "number" ? options.landing.cuLimit : draftPlan.draft.cuLimit ?? 600_000);
    if (options.computeUnits === "auto" || options.landing?.cuLimit === "auto") {
      if (options.skipSimulation) throw new Error("Automatic compute sizing requires simulation");
      const multiplier = options.computeUnitMultiplier ?? options.landing?.computeUnitMultiplier ?? 1.3;
      let probe = await this.compile(this.signer(wallet), { ...draftPlan.draft, cuLimit: computeLimit });
      let simulation = await this.simulatePlan(probe);
      if (isComputeExhausted(simulation) && computeLimit < 1_400_000) {
        probe = await this.compile(this.signer(wallet), { ...draftPlan.draft, cuLimit: 1_400_000 });
        simulation = await this.simulatePlan(probe);
      }
      if (!simulation.success) throw new Error(`Simulation failed: ${JSON.stringify(simulation.error)}\n${simulation.logs.join("\n")}`);
      computeLimit = simulationComputeLimit(simulation, multiplier);
    }
    if (policy.maxFeeBpsOfNotional != null) {
      const notional = draftPlan.draft.actions.reduce((total, action) => total + BigInt(String(action.kind === "buy" ? action.meta?.inputRaw ?? 0 : action.kind === "sell" ? action.meta?.minOutputRaw ?? 0 : 0)), 0n);
      const tipLamports = draftPlan.draft.actions.filter((action) => action.kind === "landing-tip").reduce((total, action) => total + BigInt(String(action.meta?.lamports ?? 0)), 0n);
      const networkBaseEstimate = BigInt(5_000 * (draftPlan.transaction?.message.header.numRequiredSignatures ?? 1)) + tipLamports;
      const totalCap = notional * BigInt(policy.maxFeeBpsOfNotional) / 10_000n;
      if (networkBaseEstimate > totalCap) throw Object.assign(new Error("Estimated base fee exceeds landing.maxFeeBpsOfNotional"), { code: "FEE_CAP_EXCEEDED" });
      const relativeCap = totalCap > networkBaseEstimate ? totalCap - networkBaseEstimate : 0n;
      policy.maxPriorityFeeLamports = Math.min(policy.maxPriorityFeeLamports, Number(relativeCap > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : relativeCap));
    }
    let samples: number[] = [];
    if (policy.microLamports == null) {
      const writable = new Map([[draftPlan.payer.toBase58(), draftPlan.payer]]);
      for (const ix of draftPlan.draft.instructions)
        for (const key of ix.keys)
          if (key.isWritable) writable.set(key.pubkey.toBase58(), key.pubkey);
      const addresses = [...writable.values()];
      try {
        samples = (await this.connection().getRecentPrioritizationFees(
          addresses.length <= 128 ? { lockedWritableAccounts: addresses } : undefined,
        )).map((row) => row.prioritizationFee);
      } catch {}
    }
    const fee = chooseTradeFee(policy, computeLimit, samples, previousFee);
    const plan = await this.compile(this.signer(wallet), {
      ...draftPlan.draft, cuLimit: computeLimit, cuPriceMicroLamports: fee,
    });
    return { plan, priorityMicroLamports: fee };
  }

  /** Rebuild only after the old signature is proven absent after finalized expiry. */
  async executeTradePlan(
    wallet: WalletRef,
    buildPlan: () => Promise<PlannedTransaction>,
    via: SenderId,
    kind: "buy" | "sell" | "transfer-sol" | "transfer-token" | "claim" | "deploy-token",
    options: TradeExecutionOptions = {},
  ) {
    let policy: ReturnType<typeof normalizeLandingPolicy>;
    try {
      policy = normalizeLandingPolicy({ ...options.landing, microLamports: options.priorityFee?.microLamports ?? options.landing?.microLamports });
      for (const [name, value] of Object.entries(options.confirm ?? {}))
        if (value != null && (!Number.isFinite(value) || value < 1_000)) throw new Error(`confirm.${name} must be at least 1000ms`);
    } catch (error) { throw new TradePreSubmissionError(error); }
    let previousFee: number | undefined;
    const attempts: Array<{ executionId: number; signature: string; priorityMicroLamports: number }> = [];
    const submit = async (attempt: number) => {
      notifyTrade(() => options.onAttempt?.(attempt + 1));
      if (attempt > 0) {
        this.blockhash.invalidate();
        this.cache.invalidate();
      }
      let plan: PlannedTransaction;
      let fee: number;
      try {
        const draftPlan = await buildPlan();
        const prepared = await this.prepareTradePlan(wallet, draftPlan, options, previousFee);
        fee = prepared.priorityMicroLamports;
        plan = prepared.plan;
      } catch (error) {
        throw new TradePreSubmissionError(error);
      }
      const submission = await this.submitPlan(plan, via, kind, { ...options, fallbackSenders: Array.isArray(options.via) ? options.via.slice(1) : [] });
      previousFee = fee;
      attempts.push({ executionId: submission.executionId, signature: submission.signature,
        priorityMicroLamports: fee });
      return submission;
    };
    const result = await runTradeAttempts(
      options.waitForConfirmation === false ? 1 : policy.maxAttempts,
      async (attempt) => {
        try {
          return await submit(attempt);
        } catch (error) {
          if (kind !== "buy" || options.skipSimulation || !isPumpSwap6040SimulationError(error)) throw error;
          this.cache.invalidate();
          return await submit(attempt);
        }
      },
      async (submission): Promise<SendReceipt> => options.waitForConfirmation === false
        ? { signature: submission.signature, sender: submission.sender, status: "submitted", slot: null }
        : await this.settleSubmission(submission, options.confirm?.pollIntervalMs ?? 1_000,
            options.confirm?.timeoutMs ?? 180_000, options.confirm?.resendIntervalMs ?? 1_500),
    );
    if (result.receipt.status === "confirmed") {
      try {
        const fill = storedTradeFill(this.executions.get(result.submission.executionId));
        if (fill) result.receipt = { ...result.receipt,
          solPrincipalDeltaLamports: BigInt(fill.economicLamports),
          targetTokenDeltaRaw: BigInt(fill.tokenDeltaRaw),
          networkFeeLamports: BigInt(fill.networkFeeLamports) };
      } catch { /* Preserve confirmation if accounting storage is unavailable. */ }
    }
    result.receipt = { ...result.receipt, feeEstimate: result.submission.feeEstimate,
      tipLamports: (result.submission.plan?.draft?.actions ?? []).filter((action) => action.kind === "landing-tip").reduce((total, action) => total + Number(action.meta?.lamports ?? 0), 0) };
    return { ...result, attempts };
  }

  async buy(
    token: TokenRef,
    wallet: WalletRef,
    amount: HumanAmount,
    options: TradeExecutionOptions & { slippageBps?: number; minOutputRaw?: bigint | string; maxPriceSol?: string | number; reserves?: import("../venues/venue-plugin.ts").LivePoolReserves } = {},
  ) {
    const outcome = await this.runReliableTrade(wallet, options.intentKey, JSON.stringify(["buy", tradeTokenKey(token), toRawAmount(amount).raw.toString(), options.minOutputRaw?.toString(), options.slippageBps, options.maxPriceSol], (_key, value) => typeof value === "bigint" ? value.toString() : value), async () => {
    const result = await this.executeTradePlan(wallet,
      () => this.tx(wallet).priorityFee(options.priorityFee ?? {}).buy(token, amount, options).build(),
      options.landing?.route ?? options.heliusTier ?? (Array.isArray(options.via) ? options.via[0] : options.via) ?? "rpc", "buy", options);
    const settled = tradeResult(result.receipt, result.attempts, result.submission.executionId);
    return settled;
    });
    notifyTrade(() => options.onSettled?.(outcome)); return outcome;
  }
  async buyMany(
    token: TokenRef,
    wallets: WalletRef[],
    amount: HumanAmount,
    options: {
      slippageBps?: number;
      landing?: TradeLandingPolicy;
      waitForConfirmation?: boolean;
      priorityFee?: { cuLimit?: number; microLamports?: number };
      via?: SenderId;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ) {
    if (!isBundleSender(this.senders.resolve(options.via ?? "rpc"))) {
      if (!wallets.length) throw new Error("Cannot trade with an empty wallet list");
      return { sender: String(options.via ?? "rpc"), mode: "parallel" as const,
        receipts: await Promise.all(wallets.map((wallet) => this.buy(token, wallet, amount, options))) };
    }
    return await this.composeMany(wallets)
      .priorityFee(options.priorityFee ?? {})
      .buy(token, amount, options)
      .send({
        via: options.via ?? "rpc",
        kind: "buy:many",
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
  }
  async sell(
    token: TokenRef,
    wallet: WalletRef,
    options: TradeExecutionOptions & { bps?: number; slippageBps?: number; minOutputLamports?: bigint | string; minPriceSol?: string | number; reserves?: import("../venues/venue-plugin.ts").LivePoolReserves; closeTokenAccount?: boolean } = {},
  ) {
    const outcome = await this.runReliableTrade(wallet, options.intentKey, JSON.stringify(["sell", tradeTokenKey(token), options.bps ?? 10_000, options.minOutputLamports?.toString(), options.slippageBps, options.minPriceSol, options.closeTokenAccount]), async () => {
    const result = await this.executeTradePlan(wallet,
      () => this.tx(wallet).priorityFee(options.priorityFee ?? {}).sell(token, options).build(),
      options.landing?.route ?? options.heliusTier ?? (Array.isArray(options.via) ? options.via[0] : options.via) ?? "rpc", "sell", options);
    const settled = tradeResult(result.receipt, result.attempts, result.submission.executionId);
    return settled;
    });
    notifyTrade(() => options.onSettled?.(outcome)); return outcome;
  }
  /** Serializes convenience trades in this process; intent keys arbitrate across processes. */
  private static readonly walletTradeQueues = new Map<string, Promise<unknown>>();
  async runReliableTrade(wallet: WalletRef, intentKey: string | undefined, fingerprint: string, operation: () => Promise<TradeResult>): Promise<TradeResult> {
    // Resolve public identity before any signing; harnesses may override signer.
    let address: string;
    try { address = this.signer(wallet).publicKey.toBase58(); }
    catch (error) { return failedTrade(new TradePreSubmissionError(error)); }
    const queueKey = `${this.dbPath ?? "local"}:${address}`;
    const previous = Solard.walletTradeQueues.get(queueKey) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const store = intentKey ? new TradeIntentStore(this.db) : null;
      if (store && intentKey && !store.claim(intentKey, fingerprint, address)) {
        const existing = store.get(intentKey)!;
        if (existing.fingerprint !== fingerprint || existing.wallet !== address)
          return failedTrade(Object.assign(new Error("intentKey already belongs to another trade"), { code: "INTENT_CONFLICT" }));
        return await this.resumeTrade(intentKey);
      }
      let result: TradeResult;
      try { result = await operation(); }
      catch (error) {
        const intent = intentKey ? store?.get(intentKey) : null;
        if (intent?.submissions.length && !isDefinitivePreSubmissionError(error)) {
          return await this.resumeTrade(intentKey!);
        }
        result = failedTrade(error);
        if (!isDefinitivePreSubmissionError(error)) result = { ...result, status: "unresolved", phase: "unknown", code: "UNRESOLVED", retryable: false };
      }
      if (store && intentKey) {
        try { store.update(intentKey, (intent) => { intent.result = result; }); }
        catch { /* Signed intent history remains durable; preserve known on-chain outcome. */ }
      }
      return result;
    });
    Solard.walletTradeQueues.set(queueKey, pending);
    try { return await pending; }
    finally { if (Solard.walletTradeQueues.get(queueKey) === pending) Solard.walletTradeQueues.delete(queueKey); }
  }
  async resumeTrade(intentKey: string): Promise<TradeResult> {
    const store = new TradeIntentStore(this.db); const intent = store.get(intentKey);
    if (!intent) return failedTrade(Object.assign(new Error("Unknown trade intent"), { code: "UNKNOWN_INTENT" }));
    if (intent.result && intent.result.status !== "unresolved") return intent.result;
    const attempts = intent.submissions.map(({ executionId, signature, priorityMicroLamports }) => ({ executionId, signature, priorityMicroLamports }));
    const last = intent.submissions.at(-1);
    if (!last) return { ...failedTrade(new Error("Intent was reserved before submission; manual recovery required")), status: "unresolved", phase: "unknown", code: "UNRESOLVED" };
    let receipt: SendReceipt;
    try { receipt = await this.confirmSignature(last.signature, last.sender, 1_000); }
    catch { receipt = { status: "submitted", signature: last.signature, sender: last.sender, slot: null }; }
    if (receipt.status === "submitted") {
      try {
        const execution = this.executions.get(last.executionId);
        const meta = executionMeta(execution.metaJson);
        if (typeof meta.signedTransactionBase64 === "string" && meta.recentBlockhash &&
            meta.lastValidBlockHeight === last.lastValidBlockHeight) {
          const transaction = VersionedTransaction.deserialize(Buffer.from(meta.signedTransactionBase64, "base64"));
          const payer = transaction.message.staticAccountKeys[0]!;
          const plan: PlannedTransaction = { transaction, payer,
            recentBlockhash: transaction.message.recentBlockhash, lastValidBlockHeight: last.lastValidBlockHeight,
            serializedSize: transaction.serialize().length, lookupTables: [],
            draft: { instructions: [], signers: [], actions: [], trackedAccounts: [] } };
          if (plan.recentBlockhash !== meta.recentBlockhash || signedPlanSignature(plan) !== last.signature)
            throw new Error("Stored transaction identity mismatch");
          receipt = await this.settleSubmission({ signature: last.signature, sender: last.sender,
            executionId: last.executionId, plan });
        }
      } catch { /* Retain the original uncertainty when journal transport is unavailable. */ }
    }
    if (receipt.status === "submitted" && await inspectExpiredSubmission(this.connection(), last.signature, last.lastValidBlockHeight) === "expired-unobserved") {
      receipt = { ...receipt, status: "failed", retryable: true, error: "Transaction expired at finalized block height; history proves absence" };
    }
    if (receipt.status === "confirmed") {
      try {
        const fill = storedTradeFill(this.executions.get(last.executionId));
        if (fill) receipt = { ...receipt, solPrincipalDeltaLamports: BigInt(fill.economicLamports), targetTokenDeltaRaw: BigInt(fill.tokenDeltaRaw), networkFeeLamports: BigInt(fill.networkFeeLamports) };
      } catch { /* Accounting unavailability cannot erase known confirmation. */ }
    }
    const result = tradeResult(receipt, attempts, last.executionId);
    store.update(intentKey, (row) => { row.result = result; });
    return result;
  }
  reconcile(intentKey: string) { return this.resumeTrade(intentKey); }
  async closeEmptyTokenAccounts(wallet: WalletRef, options: TokenMaintenanceOptions & TradeExecutionOptions = {}) {
    const owner = this.signer(wallet).publicKey;
    const prepared = await prepareTokenAccountMaintenance(this.connection(), owner, await listOwnedTokenAccounts(this.connection(), owner), options);
    const receipts: Array<{ accounts: typeof prepared.batches[number]["accounts"]; result: TradeResult; reclaimedLamports: bigint | null }> = [];
    for (let index = 0; index < prepared.batches.length; index++) {
      const batch = prepared.batches[index]!;
      const intentKey = options.intentKey ? `${options.intentKey}:maintenance:${index}` : undefined;
      const result = await this.runReliableTrade(wallet, intentKey, JSON.stringify(batch.accounts.map((row) => [row.address, row.burnedRaw.toString()])), async () => {
        const execution = await this.executeTradePlan(wallet, () => this.compile(this.signer(wallet), batch.draft),
          options.landing?.route ?? (Array.isArray(options.via) ? options.via[0] : options.via) ?? "rpc", "transfer-token", { ...options, intentKey });
        return tradeResult(execution.receipt, execution.attempts, execution.submission.executionId);
      });
      let reclaimedLamports: bigint | null = result.status === "failed" ? 0n : null;
      if (result.status === "confirmed" && result.signature) {
        try {
          const transaction = await this.connection().getParsedTransaction(result.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
          if (transaction?.meta && !transaction.meta.err) {
            const keys = transaction.transaction.message.accountKeys.map((key) => key.pubkey.toBase58());
            reclaimedLamports = batch.accounts.reduce((sum, account) => {
              const position = keys.indexOf(account.address);
              return position >= 0 && transaction.meta!.postBalances[position] === 0 ? sum + BigInt(transaction.meta!.preBalances[position] ?? 0) : sum;
            }, 0n);
          }
        } catch { /* Confirmed accounting can be recovered from the ledger later. */ }
      }
      receipts.push({ accounts: batch.accounts, result, reclaimedLamports });
      if (result.status === "unresolved") break;
    }
    return { receipts, skipped: prepared.skipped, complete: receipts.length === prepared.batches.length && receipts.every((row) => row.result.status !== "unresolved") };
  }
  async curveLiquidity(tokenRef: TokenRef) {
    const token = await this.resolveTokenForExecution(tokenRef);
    const curve = await fetchCurve(this.connection(), token);
    if (!curve) return null;
    return { address: curve.address.toBase58(), quoteMint: curve.quoteAsset.mint.toBase58(), quoteDecimals: curve.quoteAsset.decimals,
      virtualBaseReserveRaw: curve.virtualBase, virtualQuoteReserveRaw: curve.virtualQuote,
      realBaseReserveRaw: curve.realBase, realQuoteReserveRaw: curve.realQuote,
      totalSupplyRaw: curve.totalSupply, complete: curve.complete };
  }
  async maxSendableSol(wallet: WalletRef, options: { keepForSells?: boolean | number; reserveLamports?: bigint } = {}): Promise<bigint> {
    const payer = this.signer(wallet).publicKey;
    const connection = this.connection();
    const latest = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: latest.blockhash, instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: PublicKey.default, lamports: 0 }),
    ] }).compileToV0Message();
    const fee = (await connection.getFeeForMessage(message, "confirmed")).value;
    if (fee == null) throw new TradePreSubmissionError(new Error("Unable to estimate withdrawal fee"));
    const balance = BigInt(await connection.getBalance(payer, "confirmed"));
    const reserve = options.reserveLamports ?? (typeof options.keepForSells === "number" ? BigInt(options.keepForSells) : options.keepForSells ? BigInt((await this.tokenAccounts(wallet)).filter((row) => row.amountRaw > 0n).length) * 2_100_000n : 0n);
    if (reserve < 0n) throw new Error("Withdrawal reserve cannot be negative");
    const available = balance - BigInt(fee) - reserve;
    return available > 0n ? available : 0n;
  }
  async transferToken(wallet: WalletRef, mint: TokenRef, destination: string | PublicKey, amount: bigint | "all", options: TradeExecutionOptions = {}): Promise<TradeResult> {
    return this.runReliableTrade(wallet, options.intentKey, JSON.stringify(["transfer-token", String(mint), String(destination), String(amount)]), async () => {
      const plan = await this.tx(wallet).priorityFee(options.priorityFee ?? {}).transferToken(mint, destination, amount).build();
      const submission = await this.submitPlan(plan, (Array.isArray(options.via) ? options.via[0] : options.via) ?? "rpc", "transfer-token", options);
      const receipt = options.waitForConfirmation === false ? { signature: submission.signature, sender: submission.sender, status: "submitted" as const, slot: null } : await this.settleSubmission(submission);
      return tradeResult(receipt, [], submission.executionId);
    });
  }
  async exitWallet(wallet: WalletRef, destination: string | PublicKey, options: TradeExecutionOptions = {}) {
    const report: Array<{ mint: string; operation: "sell" | "transfer" | "unsupported"; result?: TradeResult; message?: string }> = [];
    const accounts = await this.tokenAccounts(wallet);
    const seenMints = new Set<string>();
    for (const account of accounts.filter((row) => row.amountRaw > 0n)) {
      if (seenMints.has(account.mint)) continue;
      seenMints.add(account.mint);
      const sold = account.isAssociated ? await this.sell(account.mint, wallet, { ...options, intentKey: options.intentKey ? `${options.intentKey}:${account.mint}:sell` : undefined }) : failedTrade(Object.assign(new Error("Non-associated balance requires transfer"), { code: "NO_ROUTE" }));
      if (sold.status === "confirmed") {
        report.push({ mint: account.mint, operation: "sell", result: sold });
        if (!accounts.some((row) => row.mint === account.mint && !row.isAssociated && row.amountRaw > 0n)) continue;
      }
      if (sold.status === "unresolved") { report.push({ mint: account.mint, operation: "sell", result: sold }); return { status: "unresolved" as const, tokens: report, withdrawal: null }; }
      const transferred = await this.transferToken(wallet, account.mint, destination, "all", { ...options, intentKey: options.intentKey ? `${options.intentKey}:${account.mint}:transfer` : undefined });
      report.push({ mint: account.mint, operation: "transfer", result: transferred });
      if (transferred.status !== "confirmed") return { status: transferred.status, tokens: report, withdrawal: null };
    }
    const withdrawal = await this.runReliableTrade(wallet, options.intentKey ? `${options.intentKey}:withdraw` : undefined, JSON.stringify(["withdraw", String(destination)]), async () => {
      const amount = await this.maxSendableSol(wallet);
      if (!amount) return failedTrade(Object.assign(new Error("No spendable SOL remains"), { code: "INSUFFICIENT_SOL" }));
      const plan = await this.tx(wallet).transferSol(destination, { raw: amount, asset: SOL_ASSET }).build();
      const submission = await this.submitPlan(plan, "rpc", "transfer-sol", {});
      return tradeResult(await this.settleSubmission(submission), [], submission.executionId);
    });
    return { status: report.some((row) => row.operation === "unsupported") ? "partial" as const : withdrawal.status, tokens: report, withdrawal };
  }
  async quote(input: { side: "buy" | "sell"; token: TokenRef; wallet: WalletRef; amount?: HumanAmount; bps?: number; slippageBps?: number; priorityFee?: { cuLimit?: number; microLamports?: number } }) {
    const composer = this.tx(input.wallet).priorityFee(input.priorityFee ?? {});
    if (input.side === "buy") {
      if (!input.amount) throw new TradePreSubmissionError(new Error("Buy quote requires amount"));
      composer.buy(input.token, input.amount, input);
    } else composer.sell(input.token, input);
    try {
      const draft = await composer.materializedDraft();
      const action = draft.actions.find((row) => row.kind === input.side)!;
      return { venue: String(action.meta?.venue), inputRaw: BigInt(String(action.meta?.inputRaw)),
        expectedOutputRaw: action.meta?.expectedOutputRaw != null ? BigInt(String(action.meta.expectedOutputRaw)) : null,
        minOutputRaw: BigInt(String(action.meta?.minOutputRaw)),
        priorityFeeLamports: (BigInt(draft.cuLimit ?? 600_000) * BigInt(draft.cuPriceMicroLamports ?? 100_000) + 999_999n) / 1_000_000n,
        networkBaseFeeEstimateLamports: 5_000n };
    } catch (error) { throw new TradePreSubmissionError(error); }
  }
  async sellMany(
    token: TokenRef,
    wallets: WalletRef[],
    options: {
      bps?: number;
      slippageBps?: number;
      landing?: TradeLandingPolicy;
      waitForConfirmation?: boolean;
      priorityFee?: { cuLimit?: number; microLamports?: number };
      via?: SenderId;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ) {
    if (!isBundleSender(this.senders.resolve(options.via ?? "rpc"))) {
      if (!wallets.length) throw new Error("Cannot trade with an empty wallet list");
      return { sender: String(options.via ?? "rpc"), mode: "parallel" as const,
        receipts: await Promise.all(wallets.map((wallet) => this.sell(token, wallet, options))) };
    }
    return await this.composeMany(wallets)
      .priorityFee(options.priorityFee ?? {})
      .sell(token, options)
      .send({
        via: options.via ?? "rpc",
        kind: "sell:many",
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
  }
  async unwrapWsol(
    wallet: WalletRef,
    options: {
      via?: SenderId;
      destination?: string | PublicKey;
      skipMissing?: boolean;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ) {
    return await this.tx(wallet)
      .unwrapWsol({
        destination: options.destination,
        skipMissing: options.skipMissing,
      })
      .send({
        via: options.via ?? "rpc",
        kind: "unwrap-wsol",
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
  }
  async unwrapWsolMany(
    wallets: WalletRef[],
    options: {
      via?: SenderId;
      skipMissing?: boolean;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ) {
    return await this.composeMany(wallets)
      .unwrapWsol({ skipMissing: options.skipMissing })
      .send({
        via: options.via ?? "rpc",
        kind: "unwrap-wsol:many",
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
  }
  async claim(
    token: TokenRef,
    wallet: WalletRef,
    options: { via?: SenderId } = {},
  ) {
    return (await this.claimCreatorFees(token, wallet, { via: options.via }))
      .receipt;
  }
  async claimCreatorFees(
    token: TokenRef,
    wallet: WalletRef,
    options: ClaimCreatorRewardsOptions = {},
  ): Promise<CreatorRewardClaimResult> {
    return await claimCreatorRewards(this, token, wallet, options);
  }

  /** Complete on-chain holder snapshot. Use this, not websocket deltas, for payouts. */
  async snapshotHolders(
    tokenRef: TokenRef,
    options: Omit<TokenHolderSnapshotOptions, "token"> = {},
  ) {
    const token = this.resolveToken(tokenRef);
    return await snapshotTokenHolders(this.connection(), token.mint, {
      ...options,
      token,
    });
  }

  /** Typed Pump/PumpSwap swap + mint-mentioned SPL transfer stream for one token. */
  async subscribeTokenEvents(
    tokenRef: TokenRef,
    options: SubscribeTokenEventsOptions = {},
  ) {
    const token = this.resolveToken(tokenRef);
    return await openTokenEventStream({
      connection: this.connection(),
      token,
      options,
    });
  }

  async historyTokenEvents(
    tokenRef: TokenRef,
    options: TokenEventHistoryOptions = {},
  ) {
    const token = this.resolveToken(tokenRef);
    return await openTokenEventHistory({
      connection: this.connection(),
      token,
      options,
    });
  }

  async historyCreatorRewards(
    tokenRef: TokenRef,
    options: CreatorRewardHistoryOptions = {},
  ) {
    const token = this.resolveToken(tokenRef);
    return await historyCreatorRewards({
      connection: this.connection(),
      token,
      options,
    });
  }

  private async marketHistory(
    tokenRef: TokenRef,
    options: MarketHistoryOptions = {},
  ): Promise<MarketHistory> {
    const token = await this.resolveReplayToken(tokenRef);
    const repository = new SqliteTokenHistoryRepository(this.db);
    let coverage = repository.getCoverage(token.mint);
    const shouldBackfill =
      options.backfill !== false &&
      (!coverage?.complete || options.replace === true);
    if (shouldBackfill) {
      const {
        backfill: _backfill,
        maxRaydiumPools,
        ...backfillOptions
      } = options;
      try {
        coverage = await backfillTokenHistory(
          this.connection(),
          token.mint,
          backfillOptions,
          repository,
        );
      } catch (error) {
        if (
          !(error instanceof TokenHistoryError) ||
          error.code !== "UNSUPPORTED_TOKEN"
        )
          throw error;
        coverage = await backfillRaydiumTokenHistory(
          this.connection(),
          token.mint,
          { ...backfillOptions, maxRaydiumPools },
          repository,
        );
      }
    }
    if (!coverage)
      throw new Error(
        `Market history for ${token.mint} has not been backfilled`,
      );
    return {
      mint: token.mint,
      quoteMint: coverage.quoteMint,
      coverage,
      candles1s: repository.loadCandles1s(token.mint),
    };
  }

  private async resolveReplayToken(ref: TokenRef): Promise<TokenRow> {
    try {
      return this.resolveToken(ref);
    } catch (error) {
      if (ref instanceof PublicKey) return await this.addToken(ref.toBase58());
      if (typeof ref === "string") {
        try {
          return await this.addToken(new PublicKey(ref.trim()).toBase58());
        } catch {
          throw error;
        }
      }
      throw error;
    }
  }

  async replayHistory(
    tokenRef: TokenRef,
    options: ReplayOptions = {},
  ): Promise<ReplayHistory> {
    const token = await this.resolveReplayToken(tokenRef);
    return await replayTokenHistory({
      connection: this.connection(),
      database: this.db,
      token,
      options,
    });
  }

  async replayEvents(
    tokenRef: TokenRef,
    options: ReplayEventsOptions = {},
  ): Promise<ReplayEventSubscription> {
    const token = await this.resolveReplayToken(tokenRef);
    const initialThroughSlot = replayCoverageThroughSlot(this.db, token.mint);
    return await subscribeReplayEvents({
      mint: token.mint,
      initialThroughSlot,
      options,
      replay: (replayOptions) => this.replayHistory(token.mint, replayOptions),
    });
  }

  private async transferAsset(
    asset: "SOL" | string | PublicKey | QuoteAsset,
  ): Promise<QuoteAsset> {
    if (
      typeof asset === "object" &&
      !(asset instanceof PublicKey) &&
      "kind" in asset
    )
      return asset;
    const raw =
      asset instanceof PublicKey ? asset.toBase58() : String(asset).trim();
    if (!raw || raw.toUpperCase() === "SOL" || raw === NATIVE_MINT.toBase58())
      return SOL_ASSET;
    const mint = new PublicKey(raw);
    const info = await readMint(this.connection(), mint);
    return {
      kind: "spl-token",
      mint,
      tokenProgram: info.tokenProgram,
      decimals: info.decimals,
    };
  }

  /** Read-only size-aware packing of many payments into v0 transactions. */
  async planTransferMany(args: {
    wallet: WalletRef;
    asset: "SOL" | string | PublicKey | QuoteAsset;
    allocations: TransferManyAllocation[];
    cuLimit?: number;
    priorityMicroLamports?: number;
    maxRecipientsPerTransaction?: number;
  }) {
    const payer = this.resolveWallet(args.wallet).address;
    return await packTransferMany({
      connection: this.connection(),
      payer,
      asset: await this.transferAsset(args.asset),
      allocations: args.allocations,
      altAddresses: this.alts.list().map((row) => row.address),
      cuLimit: args.cuLimit,
      priorityMicroLamports: args.priorityMicroLamports,
      maxRecipientsPerTransaction: args.maxRecipientsPerTransaction,
    });
  }

  /**
   * Crash-safe arbitrary payout execution. A stable id is mandatory. The economic
   * allocation set is persisted before signing, and each signed transaction plus
   * its allocation ids are persisted before broadcast.
   */
  async sendTransferMany(args: {
    id: string;
    wallet: WalletRef;
    asset: "SOL" | string | PublicKey | QuoteAsset;
    allocations: TransferManyAllocation[];
    via?: SenderId;
    cuLimit?: number;
    priorityMicroLamports?: number;
    maxRecipientsPerTransaction?: number;
    skipSimulation?: boolean;
    skipPreflight?: boolean;
  }) {
    const asset = await this.transferAsset(args.asset);
    return await executeDurableTransferMany(this, {
      id: args.id,
      wallet: args.wallet,
      asset,
      allocations: args.allocations,
      via: args.via,
      cuLimit: args.cuLimit,
      priorityMicroLamports: args.priorityMicroLamports,
      maxRecipientsPerTransaction: args.maxRecipientsPerTransaction,
      skipSimulation: args.skipSimulation,
      skipPreflight: args.skipPreflight,
    });
  }

  /** Read the locally persisted state for a stable transfer-many id. */
  getTransferManyStatus(id: string) {
    return durableTransferManyStatus(this, id);
  }

  /** Reconcile/resume a durable transfer-many id without re-supplying allocations. */
  async resumeTransferMany(
    id: string,
    options: DurableTransferManyResumeOptions = {},
  ) {
    return await resumeDurableTransferMany(this, id, options);
  }

  async planDistribution(options: CumulativeDistributionInput) {
    return await planCumulativeDistribution(this, options);
  }

  async executeDistribution(options: CumulativeDistributionExecuteOptions) {
    return await executeCumulativeDistribution(this, options);
  }

  distributionStatus(id: string) {
    return getCumulativeDistributionState(this, id);
  }

  listAgents() {
    return this.agentRepo.list();
  }
  configureAgent(name: string, config: Record<string, unknown>): SolardAgent {
    const row = this.agentRepo.configure(name, config);
    const wallet = config.wallet;
    if (typeof wallet !== "string")
      throw new Error("Agent config requires wallet: <wallet ref>");
    return new SolardAgent(row, this.agentRepo, this, wallet);
  }
  agent(name: string, wallet?: WalletRef): SolardAgent {
    const row = this.agentRepo.resolve(name);
    const config = this.agentRepo.config(row);
    const resolvedWallet =
      wallet ?? (typeof config.wallet === "string" ? config.wallet : undefined);
    if (!resolvedWallet)
      throw new Error(
        `Agent ${name} has no wallet. Configure it with slrd agent create ${name} --wallet <wallet>`,
      );
    return new SolardAgent(row, this.agentRepo, this, resolvedWallet);
  }
  watchToken(ref: TokenRef, label?: string) {
    return this.watcher.watchToken(this.resolveToken(ref).mint, label);
  }
  watchWallet(ref: WalletRef, label?: string) {
    return this.watcher.watchWallet(
      this.resolveWallet(ref).address.toBase58(),
      label,
    );
  }
  watchProgram(address: string | PublicKey, label?: string) {
    return this.watcher.watchProgram(
      typeof address === "string"
        ? new PublicKey(address).toBase58()
        : address.toBase58(),
      label,
    );
  }

  async createAlt(
    authority: WalletRef,
  ): Promise<{ address: string; receipt: SendReceipt }> {
    const signer = this.signer(authority);
    const slot = await this.connection().getSlot("confirmed");
    const [ix, address] = AddressLookupTableProgram.createLookupTable({
      authority: signer.publicKey,
      payer: signer.publicKey,
      recentSlot: slot,
    });
    const draft = this.transaction(signer)
      .add(ix, { kind: "alt-create", meta: { address: address.toBase58() } })
      .snapshot();
    const plan = await this.compile(signer, draft, { useAlts: false });
    const receipt = await this.sendPlan(plan, "rpc", "alt-create");
    if (receipt.status !== "failed") this.alts.register(address.toBase58());
    return { address: address.toBase58(), receipt };
  }
  async extendAlt(
    address: string,
    authority: WalletRef,
    accounts: string[],
  ): Promise<SendReceipt> {
    const signer = this.signer(authority);
    const ix = AddressLookupTableProgram.extendLookupTable({
      payer: signer.publicKey,
      authority: signer.publicKey,
      lookupTable: new PublicKey(address),
      addresses: accounts.map((value) => new PublicKey(value)),
    });
    const draft = this.transaction(signer)
      .add(ix, { kind: "alt-extend", meta: { address, accounts } })
      .snapshot();
    const plan = await this.compile(signer, draft, { useAlts: false });
    return await this.sendPlan(plan, "rpc", "alt-extend");
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeDatabase(this.dbPath);
  }
}
export class SolardGroup {
  constructor(
    private readonly slrd: Solard,
    readonly name: string,
    readonly walletAddresses: string[],
  ) {}
  buy(
    token: TokenRef,
    amount: HumanAmount,
    options: {
      slippageBps?: number;
      via?: SenderId;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ) {
    return this.slrd
      .composeMany(this.walletAddresses)
      .buy(token, amount, options)
      .send({
        via: options.via ?? "rpc",
        kind: `group-buy:${this.name}`,
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
  }
  sell(
    token: TokenRef,
    options: {
      bps?: number;
      slippageBps?: number;
      via?: SenderId;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ) {
    return this.slrd
      .composeMany(this.walletAddresses)
      .sell(token, options)
      .send({
        via: options.via ?? "rpc",
        kind: `group-sell:${this.name}`,
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
  }
  unwrapWsol(
    options: {
      via?: SenderId;
      skipMissing?: boolean;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ) {
    return this.slrd
      .composeMany(this.walletAddresses)
      .unwrapWsol({ skipMissing: options.skipMissing })
      .send({
        via: options.via ?? "rpc",
        kind: `group-unwrap-wsol:${this.name}`,
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
  }
}
