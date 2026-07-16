#!/usr/bin/env bun
import {
  appendCopyTradeIntentOnce,
  getCopyTradeProfile,
  getCopyTradeTokenContext,
  isSqliteBusyError,
  listCopyTradeIntents,
  listCopyTradeProfiles,
  listWalletSwaps,
  recordWorkerError,
  updateCopyTradeIntent,
  upsertProcessStatus,
  type CopyTradeIntent,
  type CopyTradeProfile,
  type CopyTradeTokenContext,
  type WalletSwap,
} from "../shared/db.js";
import { compactId, dbMeasure, summarizeError } from "../shared/measure.js";
import {
  loadCopyTradeConfig,
  redactedCopyUrl,
  type CopyTradeConfig,
} from "./copy-config.js";
import { CopyTradeGateway } from "./copy-gateway.js";
import { evaluateCopyTrade } from "./copy-policy.js";
import type {
  CopyTradeCounters,
  CopyTradeGatewayRequest,
} from "./copy-types.js";

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

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function createCounters(): CopyTradeCounters {
  return {
    cycles: 0,
    profiles: 0,
    sourceSwaps: 0,
    intentsCreated: 0,
    duplicateIntents: 0,
    paperIntents: 0,
    queuedIntents: 0,
    skippedIntents: 0,
    sendAttempts: 0,
    sentIntents: 0,
    failedIntents: 0,
    retries: 0,
    errors: 0,
    lastProfileKey: null,
    lastLeaderWallet: null,
    lastSourceSignature: null,
    lastExecutionSignature: null,
    lastIntentAtMs: null,
  };
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

function intentKey(profile: CopyTradeProfile, swap: WalletSwap): string {
  return `${profile.profileKey}:${swap.eventKey}`;
}

function skippedAmountKind(swap: WalletSwap): "exact-input-ui" | "balance-bps" {
  return swap.side === "sell" ? "balance-bps" : "exact-input-ui";
}

function createIntent(
  profile: CopyTradeProfile,
  swap: WalletSwap,
  tokenContext: CopyTradeTokenContext,
  config: CopyTradeConfig,
  counters: CopyTradeCounters,
): void {
  const decision = evaluateCopyTrade(profile, swap, Date.now(), tokenContext);
  const key = intentKey(profile, swap);
  const approvedStatus = profile.mode === "paper" ? "paper" : "queued";
  const write = appendCopyTradeIntentOnce({
    intentKey: key,
    profileKey: profile.profileKey,
    leaderEventKey: swap.eventKey,
    leaderWallet: swap.wallet,
    followerRef: profile.followerRef,
    sourceSignature: swap.signature,
    sourceSlot: swap.slot,
    sourceTradedAtMs: swap.tradedAtMs,
    side: swap.side === "sell" ? "sell" : "buy",
    inputMint: swap.inputMint,
    outputMint: swap.outputMint,
    subjectMint: swap.subjectMint,
    quoteMint: swap.quoteMint,
    amountKind: decision.approved
      ? decision.amountKind
      : skippedAmountKind(swap),
    amountUi: decision.approved ? decision.amountUi : null,
    balanceBps: decision.approved ? decision.balanceBps : null,
    slippageBps: profile.slippageBps,
    mode: profile.mode,
    status: decision.approved ? approvedStatus : "skipped",
    reason: decision.approved
      ? profile.mode === "live" && !config.allowLive
        ? "waiting-for-global-live-enable"
        : null
      : decision.reason,
    attempts: 0,
    nextAttemptAtMs: 0,
    requestJson: decision.approved ? json(decision.request) : "{}",
    resultJson: "{}",
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  });

  if (!write.inserted) {
    counters.duplicateIntents++;
    return;
  }
  counters.intentsCreated++;
  counters.lastProfileKey = profile.profileKey;
  counters.lastLeaderWallet = swap.wallet;
  counters.lastSourceSignature = swap.signature;
  counters.lastIntentAtMs = Date.now();
  if (write.row.status === "paper") counters.paperIntents++;
  else if (write.row.status === "queued") counters.queuedIntents++;
  else if (write.row.status === "skipped") counters.skippedIntents++;
}

function parseRequest(intent: CopyTradeIntent): CopyTradeGatewayRequest | null {
  try {
    const value = JSON.parse(intent.requestJson);
    return value && typeof value === "object"
      ? (value as CopyTradeGatewayRequest)
      : null;
  } catch {
    return null;
  }
}

function retryDelay(config: CopyTradeConfig, attempts: number): number {
  return Math.min(
    config.retryMaxMs,
    config.retryMinMs * 2 ** Math.min(Math.max(0, attempts - 1), 8),
  );
}

async function executeIntent(
  intent: CopyTradeIntent,
  config: CopyTradeConfig,
  gateway: CopyTradeGateway,
  counters: CopyTradeCounters,
): Promise<void> {
  const profile = getCopyTradeProfile(intent.profileKey);
  if (!profile || profile.enabled <= 0 || profile.mode !== "live") {
    updateCopyTradeIntent(intent.intentKey, {
      status: "skipped",
      reason: !profile
        ? "profile-missing"
        : profile.enabled <= 0
          ? "profile-disabled"
          : "profile-not-live",
      nextAttemptAtMs: 0,
      updatedAtMs: Date.now(),
    });
    counters.skippedIntents++;
    return;
  }

  const request = parseRequest(intent);
  if (!request) {
    updateCopyTradeIntent(intent.intentKey, {
      status: "failed",
      reason: "invalid-request-json",
      attempts: intent.attempts + 1,
      nextAttemptAtMs: 0,
      updatedAtMs: Date.now(),
    });
    counters.failedIntents++;
    return;
  }
  if (Date.now() > request.expiresAtMs) {
    updateCopyTradeIntent(intent.intentKey, {
      status: "skipped",
      reason: "execution-request-expired",
      nextAttemptAtMs: 0,
      updatedAtMs: Date.now(),
    });
    counters.skippedIntents++;
    return;
  }

  if (!config.allowLive || !config.gatewayUrl) return;

  const attempts = intent.attempts + 1;
  updateCopyTradeIntent(intent.intentKey, {
    status: "sending",
    reason: null,
    attempts,
    nextAttemptAtMs: 0,
    updatedAtMs: Date.now(),
  });
  counters.sendAttempts++;
  if (attempts > 1) counters.retries++;

  try {
    const response = await gateway.execute(request);
    if (!response.accepted) {
      throw new Error(response.error ?? "executor rejected request");
    }
    updateCopyTradeIntent(intent.intentKey, {
      status: "sent",
      reason: null,
      executionSignature: response.signature ?? null,
      resultJson: json(response.result ?? response),
      nextAttemptAtMs: 0,
      updatedAtMs: Date.now(),
    });
    counters.sentIntents++;
    counters.lastExecutionSignature = response.signature ?? null;
  } catch (error) {
    const exhausted = attempts >= config.maxAttempts;
    updateCopyTradeIntent(intent.intentKey, {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      resultJson: json({
        error: error instanceof Error ? error.message : String(error),
      }),
      nextAttemptAtMs: exhausted
        ? 0
        : Date.now() + retryDelay(config, attempts),
      updatedAtMs: Date.now(),
    });
    counters.failedIntents++;
    throw error;
  }
}

function dueExecutionIntents(config: CopyTradeConfig): CopyTradeIntent[] {
  const now = Date.now();
  const queued = listCopyTradeIntents({
    status: "queued",
    dueAtMs: now,
    limit: config.executionBatchSize,
  });
  const failed = listCopyTradeIntents({
    status: "failed",
    dueAtMs: now,
    limit: config.executionBatchSize,
  }).filter(
    (intent) =>
      intent.attempts < config.maxAttempts && intent.nextAttemptAtMs > 0,
  );
  const unique = new Map<string, CopyTradeIntent>();
  for (const intent of [...queued, ...failed])
    unique.set(intent.intentKey, intent);
  return [...unique.values()]
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .slice(0, config.executionBatchSize);
}

async function recoverStaleSending(config: CopyTradeConfig): Promise<void> {
  const staleBefore =
    Date.now() - Math.max(config.gatewayTimeoutMs * 2, 15_000);
  const rows = listCopyTradeIntents({ status: "sending", limit: 1_000 });
  for (const intent of rows) {
    if (intent.updatedAtMs >= staleBefore) continue;
    updateCopyTradeIntent(intent.intentKey, {
      status: "failed",
      reason: "recovered-stale-sending-intent",
      nextAttemptAtMs: intent.attempts >= config.maxAttempts ? 0 : Date.now(),
      updatedAtMs: Date.now(),
    });
  }
}

export type CopyTradeWorkerOptions = {
  signal?: AbortSignal;
  installSignalHandlers?: boolean;
};

export async function runCopyTradeWorker(
  options: CopyTradeWorkerOptions = {},
): Promise<void> {
  const config = loadCopyTradeConfig();
  const counters = createCounters();
  const gateway = new CopyTradeGateway(config);
  const ownController = options.signal ? null : new AbortController();
  const signal = options.signal ?? ownController!.signal;
  let stopping = false;
  let running = false;

  const runCycle = async (): Promise<void> => {
    if (running || signal.aborted) return;
    running = true;
    try {
      counters.cycles++;
      const profiles = listCopyTradeProfiles({
        enabledOnly: true,
        limit: 50_000,
      });
      counters.profiles = profiles.length;
      const byLeader = new Map<string, CopyTradeProfile[]>();
      for (const profile of profiles) {
        const rows = byLeader.get(profile.leaderWallet) ?? [];
        rows.push(profile);
        byLeader.set(profile.leaderWallet, rows);
      }

      const swaps = listWalletSwaps({
        copyableOnly: true,
        sinceMs: Date.now() - config.scanLookbackMs,
        limit: config.scanBatchSize,
      })
        .filter((swap) => byLeader.has(swap.wallet))
        .filter((swap) => swap.side === "buy" || swap.side === "sell")
        .sort(
          (left, right) =>
            left.tradedAtMs - right.tradedAtMs ||
            left.eventKey.localeCompare(right.eventKey),
        );
      counters.sourceSwaps = swaps.length;

      const contextByMint = new Map<string, CopyTradeTokenContext>();
      for (const swap of swaps) {
        let context = contextByMint.get(swap.subjectMint);
        if (!context) {
          context = getCopyTradeTokenContext(swap.subjectMint);
          contextByMint.set(swap.subjectMint, context);
        }
        for (const profile of byLeader.get(swap.wallet) ?? []) {
          createIntent(profile, swap, context, config, counters);
        }
      }

      await recoverStaleSending(config);
      for (const intent of dueExecutionIntents(config)) {
        try {
          await executeIntent(intent, config, gateway, counters);
        } catch (error) {
          counters.errors++;
          recordWorkerError(config.name, error, {
            phase: "copy-execute",
            intentKey: intent.intentKey,
            profileKey: intent.profileKey,
            sourceSignature: intent.sourceSignature,
          });
        }
      }
    } finally {
      running = false;
    }
  };

  const heartbeat = setInterval(() => {
    void writeStatus({
      name: config.name,
      kind: "copy-trade-worker",
      status: "ok",
      buildId: config.buildId,
      dataJson: json({
        mode: "policy+isolated-executor-gateway",
        liveAllowed: config.allowLive,
        executorConfigured: Boolean(config.gatewayUrl),
        executorUrl: redactedCopyUrl(config.gatewayUrl),
        ...counters,
      }),
      updatedAtMs: Date.now(),
    }).catch((error) => console.error("[solard:copy] heartbeat failed", error));
  }, config.heartbeatMs);
  (heartbeat as any).unref?.();

  const timer = setInterval(() => {
    void runCycle().catch((error) => {
      counters.errors++;
      recordWorkerError(config.name, error, { phase: "copy-cycle" });
    });
  }, config.pollMs);
  (timer as any).unref?.();

  const stop = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    ownController?.abort();
    clearInterval(timer);
    clearInterval(heartbeat);
    void writeStatus({
      name: config.name,
      kind: "copy-trade-worker",
      status: "stopped",
      buildId: config.buildId,
      dataJson: json({ reason, ...counters }),
      updatedAtMs: Date.now(),
    }).catch(() => undefined);
  };

  const onAbort = () => stop("parent-abort");
  signal.addEventListener("abort", onAbort, { once: true });
  if (!options.signal && options.installSignalHandlers !== false) {
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  }

  await writeStatus({
    name: config.name,
    kind: "copy-trade-worker",
    status: "starting",
    buildId: config.buildId,
    dataJson: json({
      liveAllowed: config.allowLive,
      executorConfigured: Boolean(config.gatewayUrl),
      executorUrl: redactedCopyUrl(config.gatewayUrl),
      pollMs: config.pollMs,
      scanLookbackMs: config.scanLookbackMs,
    }),
    updatedAtMs: Date.now(),
  });

  await runCycle();
  while (!signal.aborted) {
    await sleep(60_000, signal);
  }
  signal.removeEventListener("abort", onAbort);
  stop("loop-ended");
}

if (import.meta.main) {
  runCopyTradeWorker().catch((error) => {
    console.error("[solard:copy] fatal", error);
    process.exitCode = 1;
  });
}
