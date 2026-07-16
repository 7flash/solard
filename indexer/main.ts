#!/usr/bin/env bun
import {
  SOLARD_DB_PATH,
  getTerminalToken,
  isSqliteBusyError,
  listTerminalFeed,
  recordWorkerError,
  upsertProcessStatus,
} from "../shared/db.js";
import { compactId, dbMeasure, summarizeError } from "../shared/measure.js";
import { loadConfig, redactedUrl, type IndexerConfig } from "./config.js";
import { PumpCurveSubscriptionManager } from "./pump-curve-ws.js";
import { PumpDiscoveryState } from "./pump-discovery-state.js";
import { runPumpPortalSession } from "./pumpportal-ws.js";
import { startMetadataHydrator } from "./metadata.js";
import { refreshSolUsd } from "./sol-usd.js";
import { runWalletIndexer } from "./wallet-main.js";
import { runCopyTradeWorker } from "./copy-main.js";
import type { Counters, IndexedCreate, TrackedPumpToken } from "./types.js";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function embeddedWorkerEnabled(name: string, fallback = true): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off", "disabled"].includes(value);
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

function createCounters(): Counters {
  return {
    sessions: 0,
    messages: 0,
    creates: 0,
    trades: 0,
    completes: 0,
    duplicateTrades: 0,
    rejectedUnknownTrades: 0,
    rejectedUnknownCompletes: 0,
    programDataLines: 0,
    recognizedEventLines: 0,
    unknownEventLines: 0,
    eventParseErrors: 0,
    parsedCreates: 0,
    parsedTrades: 0,
    parsedCompletes: 0,
    mayhemQueued: 0,
    mayhemChecked: 0,
    mayhemDetected: 0,
    mayhemFailed: 0,
    lastUnknownDiscriminator: null,
    lastProgramDataLength: null,
    metadataQueued: 0,
    metadataHydrated: 0,
    metadataFailed: 0,
    curveConnections: 0,
    curveConnecting: 0,
    curveSubscriptions: 0,
    curvePendingSubscriptions: 0,
    curveSubscribeRequests: 0,
    curveUnsubscriptions: 0,
    curveSubscriptionErrors: 0,
    curveReconnects: 0,
    curveNotifications: 0,
    curveWsBytes: 0,
    curveRefreshBatches: 0,
    curveRefreshAccounts: 0,
    curvePriceUpdates: 0,
    curveCompleteUpdates: 0,
    curveLifecycleEvictions: 0,
    curveCapacityEvictions: 0,
    skipped: 0,
    errors: 0,
    lastSignature: null,
    lastMint: null,
    lastMcapUsd: null,
    lastEventAtMs: null,
    solUsd: null,
    solUsdAtMs: null,
  };
}

function rowValue(row: any, key: string): unknown {
  return row?.[key] ?? row?.token?.[key] ?? row?.row?.[key];
}

function firstFinite(row: any, keys: readonly string[]): number {
  for (const key of keys) {
    const value = Number(rowValue(row, key) ?? 0);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function scanTrackedTokens(
  config: IndexerConfig,
  discovery: PumpDiscoveryState,
): TrackedPumpToken[] {
  const now = Date.now();
  const result = listTerminalFeed({
    limit: Math.max(config.maxTrackedTokens * 4, config.maxTrackedTokens),
    activeWindowMs: Math.max(
      config.activeWindowMs,
      config.interestWindowMs,
      24 * 60 * 60_000,
    ),
    includeUnpriced: true,
    source: "both",
    priceWindowTtlMs: 0,
  }) as any;
  const rows: any[] = Array.isArray(result)
    ? result
    : Array.isArray(result?.rows)
      ? result.rows
      : Array.isArray(result?.tokens)
        ? result.tokens
        : Array.isArray(result?.items)
          ? result.items
          : [];

  const accepted: TrackedPumpToken[] = [];
  for (const row of rows) {
    const mint = String(rowValue(row, "mint") ?? "");
    if (!mint || !mint.endsWith("pump") || !discovery.has(mint)) continue;
    if (String(rowValue(row, "phase") ?? "").toLowerCase() !== "pump") continue;

    const bondingCurveKey = String(rowValue(row, "bondingCurveKey") ?? "");
    if (!bondingCurveKey) continue;

    const observedAtMs = firstFinite(row, ["observedAtMs", "createdAtMs"]);
    const activityAtMs = firstFinite(row, [
      "lastTradeAtMs",
      "lastActivityAtMs",
      "priceUpdatedAtMs",
      "updatedAtMs",
      "observedAtMs",
      "createdAtMs",
    ]);
    const interestAtMs = firstFinite(row, [
      "lastInterestAtMs",
      "lastViewedAtMs",
      "lastRequestedAtMs",
      "lastOpenedAtMs",
      "lastPinnedAtMs",
    ]);
    const interestScore = Number(
      rowValue(row, "interestScore") ??
        rowValue(row, "terminalScore") ??
        rowValue(row, "watchCount") ??
        rowValue(row, "watchers") ??
        0,
    );

    if (activityAtMs > 0 && now - activityAtMs > config.activeWindowMs)
      continue;
    const hasInterest = interestAtMs > 0 || interestScore > 0;
    if (interestAtMs > 0 && now - interestAtMs > config.interestWindowMs)
      continue;
    if (config.requireInterestSignal && !hasInterest) continue;
    if (hasInterest && interestScore < config.minInterestScore) continue;

    const supplyUi = Number(rowValue(row, "supplyUi") ?? config.pumpSupplyUi);
    accepted.push({
      mint,
      bondingCurveKey,
      supplyUi:
        Number.isFinite(supplyUi) && supplyUi > 0
          ? supplyUi
          : config.pumpSupplyUi,
      observedAtMs,
      activityAtMs,
      interestAtMs,
      interestScore: Number.isFinite(interestScore) ? interestScore : 0,
    });
  }

  accepted.sort(
    (left, right) =>
      right.interestScore - left.interestScore ||
      right.interestAtMs - left.interestAtMs ||
      right.activityAtMs - left.activityAtMs ||
      right.observedAtMs - left.observedAtMs,
  );
  return accepted.slice(0, config.maxTrackedTokens);
}

function trackedFromCreate(
  config: IndexerConfig,
  event: IndexedCreate,
): TrackedPumpToken | null {
  const bondingCurveKey = String(event.bondingCurveKey ?? "");
  if (!bondingCurveKey) return null;
  const atMs =
    Number.isFinite(event.createdAtMs) && event.createdAtMs > 0
      ? event.createdAtMs
      : Date.now();
  return {
    mint: event.mint,
    bondingCurveKey,
    supplyUi: config.pumpSupplyUi,
    observedAtMs: atMs,
    activityAtMs: atMs,
    interestAtMs: 0,
    interestScore: 0,
  };
}

export async function runIndexer(): Promise<void> {
  const config = loadConfig();
  const counters = createCounters();
  const controller = new AbortController();
  const embeddedWalletIndexer = embeddedWorkerEnabled(
    "SOLARD_EMBED_WALLET_INDEXER",
    true,
  );
  const embeddedCopyWorker = embeddedWorkerEnabled(
    "SOLARD_EMBED_COPY_WORKER",
    true,
  );
  const auxiliaryTasks: Promise<void>[] = [];

  if (embeddedWalletIndexer) {
    auxiliaryTasks.push(
      runWalletIndexer({
        signal: controller.signal,
        installSignalHandlers: false,
      }).catch((error) => {
        recordWorkerError(config.name, error, {
          phase: "embedded-wallet-indexer",
        });
        console.error("[solard:indexer] embedded wallet indexer failed", error);
      }),
    );
  }

  if (embeddedCopyWorker) {
    auxiliaryTasks.push(
      runCopyTradeWorker({
        signal: controller.signal,
        installSignalHandlers: false,
      }).catch((error) => {
        recordWorkerError(config.name, error, {
          phase: "embedded-copy-worker",
        });
        console.error("[solard:indexer] embedded copy worker failed", error);
      }),
    );
  }

  const discovery = new PumpDiscoveryState(
    `${config.dbPath}.pumpportal-discovered.json`,
  );
  let stopping = false;

  const curve = new PumpCurveSubscriptionManager(config, counters, (mint) => {
    discovery.delete(mint);
  });
  curve.start(controller.signal);
  startMetadataHydrator(config, counters);

  const reconcile = () => {
    try {
      const merged = new Map<string, TrackedPumpToken>();

      // Preserve directly admitted creations even when listTerminalFeed has a
      // wrapper shape or has not refreshed its computed feed view yet.
      for (const token of curve.snapshot()) {
        const row = getTerminalToken(token.mint);
        const phase = String(row?.phase ?? "").toLowerCase();
        const observedAtMs = Number(
          row?.observedAtMs ?? token.observedAtMs ?? 0,
        );
        if (!row || phase !== "pump" || !discovery.has(token.mint)) continue;
        if (
          observedAtMs > 0 &&
          Date.now() - observedAtMs > config.activeWindowMs
        ) {
          continue;
        }
        merged.set(token.mint, token);
      }

      // Startup recovery and DB-driven lifecycle/ranking updates.
      for (const token of scanTrackedTokens(config, discovery)) {
        merged.set(token.mint, token);
      }

      curve.reconcile([...merged.values()]);
    } catch (error) {
      counters.errors++;
      console.error("[solard:pump] curve reconcile failed", error);
      recordWorkerError(config.name, error, { phase: "curve-reconcile" });
    }
  };

  const reconcileTimer = setInterval(reconcile, config.lifecycleRefreshMs);
  (reconcileTimer as any).unref?.();
  reconcile();

  const refreshPrice = async () => {
    const result = await refreshSolUsd({
      fallback: config.solUsd,
      maxAgeMs: config.solUsdRefreshMs,
      timeoutMs: 2500,
    }).catch(() => ({ value: counters.solUsd }));
    counters.solUsd = result.value ?? null;
    counters.solUsdAtMs = Date.now();
  };
  await refreshPrice();
  const solTimer = setInterval(
    () => void refreshPrice(),
    config.solUsdRefreshMs,
  );
  (solTimer as any).unref?.();

  const heartbeat = setInterval(() => {
    void writeStatus({
      name: config.name,
      kind: "indexer",
      status: "ok",
      buildId: config.buildId,
      dataJson: JSON.stringify({
        source: "pumpportal+helius-exact-logs+curve-poll",
        globalPumpSubscription: false,
        embeddedWalletIndexer,
        embeddedCopyWorker,
        pumpPortal: redactedUrl(config.pumpPortalUrl),
        heliusRpc: redactedUrl(config.rpcUrl),
        curvePollMs: config.curvePollMs,
        discoveredMints: discovery.size(),
        ...counters,
      }),
      updatedAtMs: Date.now(),
    }).catch((error) => console.error("[solard:pump] heartbeat failed", error));
  }, config.heartbeatMs);
  (heartbeat as any).unref?.();

  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    clearInterval(reconcileTimer);
    clearInterval(solTimer);
    clearInterval(heartbeat);
    curve.stop();
    discovery.save();
    void writeStatus({
      name: config.name,
      kind: "indexer",
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
    kind: "indexer",
    status: "starting",
    buildId: config.buildId,
    dataJson: JSON.stringify({
      source: "pumpportal+helius-exact-logs+curve-poll",
      globalPumpSubscription: false,
      embeddedWalletIndexer,
      embeddedCopyWorker,
      dbPath: SOLARD_DB_PATH,
      maxConnections: config.maxConnections,
      maxSubscriptionsPerConnection: config.maxSubscriptionsPerConnection,
      maxTrackedTokens: config.maxTrackedTokens,
      curvePollMs: config.curvePollMs,
    }),
    updatedAtMs: Date.now(),
  });

  let attempt = 0;
  while (!controller.signal.aborted) {
    attempt++;
    try {
      await runPumpPortalSession({
        config,
        counters,
        signal: controller.signal,
        onCreated: (event) => {
          discovery.add(event.mint, event.createdAtMs);
          const token = trackedFromCreate(config, event);
          if (token) {
            // Direct admission is the critical path: do not wait for a feed
            // rescan before polling/subscribing this new bonding curve.
            curve.admit(token);
          }
          reconcile();
        },
        onMigrated: (mint) => {
          discovery.delete(mint);
          curve.removeMint(mint);
        },
      });
      attempt = 0;
    } catch (error) {
      if (controller.signal.aborted) break;
      counters.errors++;
      recordWorkerError(config.name, error, {
        phase: "pumpportal-session",
        attempt,
      });
      await writeStatus({
        name: config.name,
        kind: "indexer",
        status: "error",
        buildId: config.buildId,
        error: error instanceof Error ? error.message : String(error),
        dataJson: JSON.stringify({ attempt, ...counters }),
        updatedAtMs: Date.now(),
      });
    }

    if (controller.signal.aborted) break;
    const delay = Math.min(
      config.reconnectMaxMs,
      config.reconnectMinMs * 2 ** Math.min(attempt, 6),
    );
    await sleep(delay, controller.signal);
  }

  stop("loop-ended");
  await Promise.allSettled(auxiliaryTasks);
}

if (import.meta.main) {
  runIndexer().catch((error) => {
    console.error("[solard:indexer] fatal", error);
    process.exitCode = 1;
  });
}
