#!/usr/bin/env bun
import {
  SOLARD_DB_PATH,
  isSqliteBusyError,
  listWatchedWallets,
  recordWorkerError,
  upsertProcessStatus,
  upsertWalletTransaction,
  type WatchedWallet,
} from "../shared/db.js";
import { compactId, dbMeasure, summarizeError } from "../shared/measure.js";
import { refreshSolUsd } from "./sol-usd.js";
import { applyWalletTransaction } from "./wallet-apply.js";
import { WalletBackfill } from "./wallet-backfill.js";
import {
  loadWalletIndexerConfig,
  redactedWalletUrl,
  type WalletIndexerConfig,
} from "./wallet-config.js";
import { parseWatchedWalletTransaction } from "./wallet-parser.js";
import type {
  WalletIndexerCounters,
  WalletConfidence,
} from "./wallet-types.js";
import { WalletTransactionSubscription } from "./wallet-ws.js";

function createCounters(): WalletIndexerCounters {
  return {
    websocketConnections: 0,
    websocketConnecting: 0,
    subscriptionRequests: 0,
    subscriptions: 0,
    unsubscriptions: 0,
    subscriptionErrors: 0,
    reconnects: 0,
    notifications: 0,
    wsBytes: 0,

    walletRefreshes: 0,
    enabledWallets: 0,

    backfillCycles: 0,
    backfillWallets: 0,
    backfillSignatures: 0,
    backfillTransactions: 0,
    backfillErrors: 0,

    parsedTransactions: 0,
    ignoredTransactions: 0,
    parsedSwaps: 0,
    duplicateSwaps: 0,
    pumpSwaps: 0,
    pumpCurveSwaps: 0,
    inferredSwaps: 0,

    errors: 0,
    lastWallet: null,
    lastSignature: null,
    lastSwapAtMs: null,

    solUsd: null,
    solUsdAtMs: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeStatus(
  input: Parameters<typeof upsertProcessStatus>[0],
): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      dbMeasure.sync(
        {
          start: () =>
            `db.upsert_process_status name=${compactId(input.name)} status=${input.status}`,
          end: (result: any) => ({
            updated: result != null,
            status: input.status,
          }),
          catch: summarizeError,
        },
        () => upsertProcessStatus(input),
      );
      return;
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= 5) throw error;
      await sleep(Math.min(500, 20 * 2 ** Math.max(0, attempt - 1)));
    }
  }
}

function confidenceFromMessage(
  message: any,
  config: WalletIndexerConfig,
): WalletConfidence {
  const value =
    message?.params?.result?.commitment ?? message?.result?.commitment;
  return value === "processed" || value === "confirmed" || value === "finalized"
    ? value
    : config.commitment;
}

function rawSignature(message: any): string {
  return String(
    message?.params?.result?.signature ?? message?.result?.signature ?? "",
  );
}

export async function runWalletIndexer(): Promise<void> {
  const config = loadWalletIndexerConfig();
  const counters = createCounters();
  const controller = new AbortController();

  let watchedRows: WatchedWallet[] = [];
  let watchedSet = new Set<string>();
  let stopping = false;
  let walletTimer: ReturnType<typeof setInterval> | null = null;
  let backfillTimer: ReturnType<typeof setInterval> | null = null;
  let solTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const processMessage = async (message: any): Promise<void> => {
    const parsed = parseWatchedWalletTransaction(message, {
      watchedWallets: watchedSet,
      config,
      solUsd: counters.solUsd,
      confidence: confidenceFromMessage(message, config),
    });
    if (!parsed) return;

    try {
      await applyWalletTransaction(parsed, counters);
    } catch (error) {
      counters.errors++;
      const signature = parsed.signature || rawSignature(message);
      for (const wallet of parsed.wallets) {
        try {
          upsertWalletTransaction({
            wallet,
            signature,
            slot: parsed.slot,
            confidence: parsed.confidence,
            parseStatus: "error",
            parserVersion: "wallet-v1",
            rawJson: JSON.stringify(parsed.raw),
            error: error instanceof Error ? error.message : String(error),
            tradedAtMs: parsed.tradedAtMs,
            updatedAtMs: Date.now(),
          });
        } catch {}
      }
      recordWorkerError(config.name, error, {
        phase: "wallet-transaction",
        signature,
        wallets: parsed.wallets,
      });
    }
  };

  const subscription = new WalletTransactionSubscription(
    config,
    counters,
    processMessage,
  );
  const backfill = new WalletBackfill(config, counters, processMessage);

  const refreshWallets = (): void => {
    try {
      watchedRows = listWatchedWallets({
        enabledOnly: true,
        limit: config.maxWallets,
      });
      watchedSet = new Set(watchedRows.map((wallet) => wallet.address));
      counters.walletRefreshes++;
      counters.enabledWallets = watchedRows.length;
      subscription.setWallets([...watchedSet]);
    } catch (error) {
      counters.errors++;
      recordWorkerError(config.name, error, { phase: "wallet-refresh" });
    }
  };

  const refreshPrice = async (): Promise<void> => {
    const result = await refreshSolUsd({
      fallback: config.solUsd,
      maxAgeMs: config.solUsdRefreshMs,
      timeoutMs: 2_500,
    }).catch(() => ({ value: counters.solUsd }));
    counters.solUsd = result.value ?? null;
    counters.solUsdAtMs = Date.now();
  };

  const stop = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    subscription.stop();
    if (walletTimer) clearInterval(walletTimer);
    if (backfillTimer) clearInterval(backfillTimer);
    if (solTimer) clearInterval(solTimer);
    if (heartbeat) clearInterval(heartbeat);
    void writeStatus({
      name: config.name,
      kind: "wallet-indexer",
      status: "stopped",
      buildId: config.buildId,
      dataJson: JSON.stringify({ reason, ...counters }),
      updatedAtMs: Date.now(),
    }).catch(() => undefined);
  };

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  await writeStatus({
    name: config.name,
    kind: "wallet-indexer",
    status: "starting",
    buildId: config.buildId,
    dataJson: JSON.stringify({
      source: "helius-transaction-subscribe",
      dbPath: SOLARD_DB_PATH,
      rpc: redactedWalletUrl(config.rpcUrl),
      websocket: redactedWalletUrl(config.wsUrl),
      commitment: config.commitment,
      backfillEnabled: config.backfillEnabled,
      backfillLimit: config.backfillLimit,
    }),
    updatedAtMs: Date.now(),
  });

  await refreshPrice();
  refreshWallets();
  subscription.start();

  walletTimer = setInterval(refreshWallets, config.walletRefreshMs);
  (walletTimer as any).unref?.();

  backfillTimer = setInterval(() => {
    void backfill.runCycle(watchedRows).catch((error) => {
      counters.errors++;
      recordWorkerError(config.name, error, { phase: "backfill-cycle" });
    });
  }, config.backfillRefreshMs);
  (backfillTimer as any).unref?.();
  void backfill.runCycle(watchedRows);

  solTimer = setInterval(() => void refreshPrice(), config.solUsdRefreshMs);
  (solTimer as any).unref?.();

  heartbeat = setInterval(() => {
    void writeStatus({
      name: config.name,
      kind: "wallet-indexer",
      status: "ok",
      buildId: config.buildId,
      dataJson: JSON.stringify({
        source: "helius-transaction-subscribe",
        rpc: redactedWalletUrl(config.rpcUrl),
        websocket: redactedWalletUrl(config.wsUrl),
        commitment: config.commitment,
        ...counters,
      }),
      updatedAtMs: Date.now(),
    }).catch((error) =>
      console.error("[solard:wallet] heartbeat failed", error),
    );
  }, config.heartbeatMs);
  (heartbeat as any).unref?.();

  await new Promise<void>((resolve) => {
    if (controller.signal.aborted) return resolve();
    controller.signal.addEventListener("abort", () => resolve(), {
      once: true,
    });
  });
}

if (import.meta.main) {
  runWalletIndexer().catch((error) => {
    console.error("[solard:wallet] fatal", error);
    process.exitCode = 1;
  });
}
