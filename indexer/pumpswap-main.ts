#!/usr/bin/env bun
import {
  appendTokenTradeOnce,
  isSqliteBusyError,
  listTerminalFeed,
  upsertProcessStatus,
  upsertTerminalToken,
} from "../shared/db.js";
import {
  compactId,
  dbMeasure,
  indexerMeasure,
  summarizeError,
} from "../shared/measure.js";
import {
  loadPumpSwapConfig,
  redactedUrl,
  USDC_MINT,
  WSOL_MINT,
  type PumpSwapConfig,
} from "./pumpswap-config.ts";
import {
  CanonicalPoolValidator,
  getTransactionsForAddress,
  SolUsdOracle,
} from "./pumpswap-rpc.ts";
import { PumpSwapStateStore } from "./pumpswap-state.ts";
import { PumpSwapSubscriptionManager } from "./pumpswap-ws.ts";
import {
  extractPumpSwapCandidates,
  normalizeTransactionNotification,
} from "./pumpswap-transaction.ts";
import type {
  PumpSwapCandidate,
  PumpSwapCounters,
  PumpSwapPoolState,
  PumpSwapReserveSample,
  TrackedMigratedToken,
} from "./pumpswap-types.ts";

function createCounters(): PumpSwapCounters {
  return {
    cycles: 0,
    trackedTokens: 0,
    trackedPools: 0,

    discoveryRequests: 0,
    discoveryTransactions: 0,
    poolsDiscovered: 0,
    discoveryMisses: 0,

    websocketConnections: 0,
    websocketConnecting: 0,
    subscriptions: 0,
    pendingSubscriptions: 0,
    subscribeRequests: 0,
    subscriptionErrors: 0,
    unsubscriptions: 0,
    reconnects: 0,
    notifications: 0,
    wsBytes: 0,
    dirtyTokens: 0,

    accountBatches: 0,
    accountsRequested: 0,
    priceUpdates: 0,
    invalidReserves: 0,

    lifecycleEvictions: 0,
    inactiveEvictions: 0,
    raydiumEvictions: 0,
    capacityEvictions: 0,

    historyRequests: 0,
    historyTransactions: 0,
    trades: 0,
    duplicateTrades: 0,

    unknownMints: 0,
    nonCanonicalPools: 0,
    unsupportedQuotes: 0,
    ambiguousSwaps: 0,
    skipped: 0,
    errors: 0,

    lastSignature: null,
    lastMint: null,
    lastTradeAtMs: null,
    lastPriceAtMs: null,

    solUsd: null,
    solUsdAtMs: null,

    mode: "tracked-account-subscriptions",
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);

    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }

    signal.addEventListener("abort", done, { once: true });
  });
}

function statusDelayMs(attempt: number): number {
  return Math.min(500, 20 * 2 ** Math.max(0, attempt - 1));
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
      await sleep(statusDelayMs(attempt), new AbortController().signal);
    }
  }
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

function firstText(row: any, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = rowValue(row, key);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

type TrackingRejection = "inactive" | "raydium" | "lifecycle" | "capacity";

type TrackingScan = {
  tracked: TrackedMigratedToken[];
  rejected: Map<string, TrackingRejection>;
};

function scanTrackedMigratedTokens(
  config: PumpSwapConfig,
  store: PumpSwapStateStore,
): TrackingScan {
  const now = Date.now();
  const rows = listTerminalFeed({
    limit: Math.max(config.maxTrackedTokens * 4, config.maxTrackedTokens),
    activeWindowMs: config.activeWindowMs,
    includeUnpriced: true,
    source: "both",
    priceWindowTtlMs: 0,
    includeMetrics: false,
  }) as any[];

  const accepted: TrackedMigratedToken[] = [];
  const rejected = new Map<string, TrackingRejection>();

  for (const row of rows) {
    const mint = String(rowValue(row, "mint") ?? "");
    if (!mint) continue;

    const phase = String(rowValue(row, "phase") ?? "").toLowerCase();
    const venue = firstText(row, [
      "venue",
      "dex",
      "migrationTarget",
      "migratedTo",
      "liquidityVenue",
      "source",
    ]);
    const venueLower = venue?.toLowerCase() ?? "";

    if (phase !== "migrated") {
      rejected.set(mint, "lifecycle");
      continue;
    }
    if (venueLower.includes("raydium")) {
      rejected.set(mint, "raydium");
      continue;
    }

    const supplyUi = Number(rowValue(row, "supplyUi") ?? 0);
    if (!Number.isFinite(supplyUi) || supplyUi <= 0) {
      rejected.set(mint, "lifecycle");
      continue;
    }

    const migrationSlot = Number(rowValue(row, "lastSlot") ?? 0);
    const observedAtMs = firstFinite(row, ["observedAtMs", "createdAtMs"]);
    const updatedAtMs = firstFinite(row, ["updatedAtMs"]);
    const existing = store.get(mint);
    const activityAtMs = Math.max(
      firstFinite(row, [
        "lastTradeAtMs",
        "lastSwapAtMs",
        "lastActivityAtMs",
        "tradedAtMs",
        "migratedAtMs",
        "updatedAtMs",
        "observedAtMs",
        "createdAtMs",
      ]),
      existing?.lastActivityAtMs ?? 0,
    );

    if (activityAtMs > 0 && now - activityAtMs > config.activeWindowMs) {
      rejected.set(mint, "inactive");
      continue;
    }

    accepted.push({
      mint,
      supplyUi,
      migrationSlot:
        Number.isFinite(migrationSlot) && migrationSlot > 0
          ? Math.trunc(migrationSlot)
          : 0,
      observedAtMs,
      updatedAtMs,
      activityAtMs,
      venue,
    });
  }

  accepted.sort(
    (left, right) =>
      right.activityAtMs - left.activityAtMs ||
      right.updatedAtMs - left.updatedAtMs ||
      right.observedAtMs - left.observedAtMs,
  );

  if (accepted.length > config.maxTrackedTokens) {
    for (const token of accepted.slice(config.maxTrackedTokens)) {
      rejected.set(token.mint, "capacity");
    }
  }

  return {
    tracked: accepted.slice(0, config.maxTrackedTokens),
    rejected,
  };
}

function reconcileTrackedTokens(
  config: PumpSwapConfig,
  store: PumpSwapStateStore,
  counters: PumpSwapCounters,
): TrackedMigratedToken[] {
  const scan = scanTrackedMigratedTokens(config, store);
  const active = new Set(scan.tracked.map((token) => token.mint));

  for (const token of scan.tracked) {
    const existing = store.get(token.mint);
    if (existing) {
      store.set({
        ...existing,
        supplyUi: token.supplyUi,
        migrationSlot: Math.max(existing.migrationSlot, token.migrationSlot),
        lastHistorySlot: Math.max(
          existing.lastHistorySlot,
          token.migrationSlot,
        ),
        lastActivityAtMs:
          Math.max(existing.lastActivityAtMs ?? 0, token.activityAtMs) || null,
      });
      continue;
    }

    store.set({
      mint: token.mint,
      supplyUi: token.supplyUi,
      migrationSlot: token.migrationSlot,
      pool: null,
      quoteMint: null,
      poolBaseTokenAccount: null,
      poolQuoteTokenAccount: null,
      lastHistorySlot: token.migrationSlot,
      lastSignature: null,
      discoveredAtMs: null,
      lastPriceAtMs: null,
      lastHistoryAtMs: null,
      lastActivityAtMs: token.activityAtMs || null,
      discoveryAttempts: 0,
      nextDiscoveryAtMs: 0,
      lastError: null,
    });
  }

  for (const state of store.values()) {
    if (active.has(state.mint)) continue;
    const reason = scan.rejected.get(state.mint) ?? "inactive";
    counters.lifecycleEvictions++;
    if (reason === "inactive") counters.inactiveEvictions++;
    else if (reason === "raydium") counters.raydiumEvictions++;
    else if (reason === "capacity") counters.capacityEvictions++;
    store.delete(state.mint);
  }

  return scan.tracked;
}

function supportedQuote(quoteMint: string): boolean {
  return quoteMint === WSOL_MINT || quoteMint === USDC_MINT;
}

function candidatePrice(
  candidate: PumpSwapCandidate,
  solUsd: number | null,
): {
  priceSol: number | null;
  priceUsd: number | null;
  marketCapSol: number | null;
  marketCapUsd: number | null;
  volumeSol: number;
} {
  let priceSol: number | null = null;
  let priceUsd: number | null = null;
  let volumeSol = 0;

  if (candidate.baseAmountUi <= 0 || candidate.quoteAmountUi <= 0) {
    return {
      priceSol: null,
      priceUsd: null,
      marketCapSol: null,
      marketCapUsd: null,
      volumeSol: 0,
    };
  }

  if (candidate.quoteMint === WSOL_MINT) {
    priceSol = candidate.quoteAmountUi / candidate.baseAmountUi;
    priceUsd = solUsd != null ? priceSol * solUsd : null;
    volumeSol = candidate.quoteAmountUi;
  } else if (candidate.quoteMint === USDC_MINT) {
    priceUsd = candidate.quoteAmountUi / candidate.baseAmountUi;
    priceSol = solUsd != null ? priceUsd / solUsd : null;
    volumeSol = solUsd != null ? candidate.quoteAmountUi / solUsd : 0;
  }

  return {
    priceSol,
    priceUsd,
    marketCapSol: null,
    marketCapUsd: null,
    volumeSol,
  };
}

async function persistCandidate(
  state: PumpSwapPoolState,
  candidate: PumpSwapCandidate,
  solUsd: number | null,
  counters: PumpSwapCounters,
): Promise<void> {
  if (candidate.baseMint !== state.mint) {
    counters.unknownMints++;
    return;
  }

  if (!supportedQuote(candidate.quoteMint)) {
    counters.unsupportedQuotes++;
    return;
  }

  const price = candidatePrice(candidate, solUsd);

  if (price.priceSol == null && price.priceUsd == null) {
    counters.ambiguousSwaps++;
    return;
  }

  const marketCapSol =
    price.priceSol != null && state.supplyUi > 0
      ? price.priceSol * state.supplyUi
      : null;
  const marketCapUsd =
    price.priceUsd != null && state.supplyUi > 0
      ? price.priceUsd * state.supplyUi
      : null;

  const write = dbMeasure.sync(
    {
      start: () =>
        `db.insert_pumpswap_trade mint=${compactId(candidate.baseMint)} pool=${compactId(candidate.pool)}`,
      end: (result: any) => ({
        inserted: result?.inserted === true,
        side: candidate.side,
        mcapUsd: marketCapUsd,
      }),
      catch: summarizeError,
    },
    () =>
      appendTokenTradeOnce({
        eventKey: `${candidate.signature}:pumpswap:${candidate.pool}:${candidate.side}`,
        mint: candidate.baseMint,
        signature: candidate.signature,
        slot: candidate.slot,
        owner: candidate.owner,
        side: candidate.side,
        tokenDeltaUi: candidate.baseAmountUi,
        solDeltaUi: price.volumeSol,
        priceSol: price.priceSol,
        priceUsd: price.priceUsd,
        marketCapUsd,
        confidence: candidate.confidence,
        source: "helius-indexer-pumpswap-history",
        rawJson: JSON.stringify({
          pool: candidate.pool,
          quoteMint: candidate.quoteMint,
          instruction: candidate.instruction,
          baseAmountUi: candidate.baseAmountUi,
          quoteAmountUi: candidate.quoteAmountUi,
          poolBaseTokenAccount: candidate.poolBaseTokenAccount,
          poolQuoteTokenAccount: candidate.poolQuoteTokenAccount,
          canonicalPoolIndex: 0,
        }),
        tradedAtMs: candidate.tradedAtMs,
        updatedAtMs: Date.now(),
      }),
  );

  if (write.inserted) counters.trades++;
  else counters.duplicateTrades++;

  dbMeasure.sync(
    {
      start: () =>
        `db.touch_pumpswap_token mint=${compactId(candidate.baseMint)}`,
      end: (result: any) => ({ updated: result != null }),
      catch: summarizeError,
    },
    () =>
      upsertTerminalToken({
        mint: candidate.baseMint,
        source: "helius-indexer-pumpswap-history",
        phase: "migrated",
        supplyUi: state.supplyUi,
        priceSol: price.priceSol,
        priceUsd: price.priceUsd,
        marketCapSol,
        marketCapUsd,
        signature: candidate.signature,
        lastSlot: candidate.slot,
        priceUpdatedAtMs: candidate.tradedAtMs,
        updatedAtMs: Date.now(),
      }),
  );

  state.lastHistorySlot = Math.max(state.lastHistorySlot, candidate.slot);
  state.lastSignature = candidate.signature;
  state.lastHistoryAtMs = Date.now();
  state.lastError = null;

  counters.lastSignature = candidate.signature;
  counters.lastMint = candidate.baseMint;
  counters.lastTradeAtMs = candidate.tradedAtMs;
}

async function discoverOne(
  config: PumpSwapConfig,
  state: PumpSwapPoolState,
  validator: CanonicalPoolValidator,
  solUsd: SolUsdOracle,
  counters: PumpSwapCounters,
): Promise<void> {
  let paginationToken: string | null = null;
  let scannedSlot = state.lastHistorySlot;
  let found: PumpSwapCandidate | null = null;
  const matching: PumpSwapCandidate[] = [];

  for (let pageIndex = 0; pageIndex < config.historyMaxPages; pageIndex++) {
    counters.discoveryRequests++;

    const page = await getTransactionsForAddress(config, state.mint, {
      afterSlot: state.lastHistorySlot,
      limit: config.discoveryLimit,
      paginationToken,
    });

    counters.discoveryTransactions += page.data.length;

    if (page.data.length === 0) break;

    for (const transaction of page.data) {
      const normalized = normalizeTransactionNotification(transaction);
      if (!normalized) continue;

      scannedSlot = Math.max(scannedSlot, normalized.slot);

      const candidates = extractPumpSwapCandidates(
        normalized,
        config.programId,
      ).filter((candidate) => candidate.baseMint === state.mint);

      for (const candidate of candidates) {
        if (!supportedQuote(candidate.quoteMint)) continue;

        const canonical = await validator.validate(
          candidate.pool,
          candidate.baseMint,
          candidate.quoteMint,
        );

        if (!canonical) {
          counters.nonCanonicalPools++;
          continue;
        }

        if (found === null) found = candidate;
        matching.push(candidate);
      }
    }

    if (found || !page.paginationToken) break;
    paginationToken = page.paginationToken;
  }

  if (!found) {
    state.lastHistorySlot = Math.max(state.lastHistorySlot, scannedSlot);
    state.discoveryAttempts++;
    state.nextDiscoveryAtMs =
      Date.now() +
      Math.min(
        config.discoveryRetryMaxMs,
        config.discoveryRetryMinMs *
          2 ** Math.min(state.discoveryAttempts - 1, 6),
      );
    state.lastError = "No canonical PumpSwap trade found yet";
    counters.discoveryMisses++;
    return;
  }

  const discovered = found as PumpSwapCandidate;
  state.pool = discovered.pool;
  state.quoteMint = discovered.quoteMint;
  state.poolBaseTokenAccount = discovered.poolBaseTokenAccount;
  state.poolQuoteTokenAccount = discovered.poolQuoteTokenAccount;
  state.discoveredAtMs = Date.now();
  state.discoveryAttempts = 0;
  state.nextDiscoveryAtMs = 0;
  state.lastError = null;
  counters.poolsDiscovered++;

  const currentSolUsd = await solUsd.get();
  counters.solUsd = currentSolUsd;
  counters.solUsdAtMs = Date.now();

  matching.sort(
    (left, right) =>
      left.slot - right.slot || left.tradedAtMs - right.tradedAtMs,
  );

  for (const candidate of matching) {
    await persistCandidate(state, candidate, currentSolUsd, counters);
  }
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;

  const worker = async () => {
    while (index < values.length) {
      const value = values[index++];
      if (value !== undefined) await work(value);
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), values.length) },
      worker,
    ),
  );
}

async function discoverPools(
  config: PumpSwapConfig,
  store: PumpSwapStateStore,
  validator: CanonicalPoolValidator,
  solUsd: SolUsdOracle,
  counters: PumpSwapCounters,
): Promise<void> {
  const now = Date.now();
  const pending = store
    .values()
    .filter(
      (state) =>
        !state.pool &&
        !state.poolBaseTokenAccount &&
        state.nextDiscoveryAtMs <= now,
    )
    .sort(
      (left, right) =>
        left.nextDiscoveryAtMs - right.nextDiscoveryAtMs ||
        left.migrationSlot - right.migrationSlot,
    )
    .slice(0, config.discoveryPerCycle);

  await mapWithConcurrency(pending, config.rpcConcurrency, async (state) => {
    try {
      await indexerMeasure.measure(
        {
          start: () => `pumpswap.discover mint=${compactId(state.mint)}`,
          end: () => ({ pool: state.pool, slot: state.lastHistorySlot }),
          catch: summarizeError,
        },
        async () => discoverOne(config, state, validator, solUsd, counters),
      );
    } catch (error) {
      counters.errors++;
      state.discoveryAttempts++;
      state.nextDiscoveryAtMs =
        Date.now() +
        Math.min(
          config.discoveryRetryMaxMs,
          config.discoveryRetryMinMs *
            2 ** Math.min(state.discoveryAttempts - 1, 6),
        );
      state.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      store.set(state);
    }
  });
}

async function persistReserveSample(
  store: PumpSwapStateStore,
  sample: PumpSwapReserveSample,
  counters: PumpSwapCounters,
): Promise<void> {
  const state = sample.state;

  dbMeasure.sync(
    {
      start: () => `db.sample_pumpswap_price mint=${compactId(state.mint)}`,
      end: (result: any) => ({
        updated: result != null,
        priceUsd: sample.priceUsd,
        mcapUsd: sample.marketCapUsd,
      }),
      catch: summarizeError,
    },
    () =>
      upsertTerminalToken({
        mint: state.mint,
        source: "helius-indexer-pumpswap-account-subscription",
        phase: "migrated",
        supplyUi: state.supplyUi,
        priceSol: sample.priceSol,
        priceUsd: sample.priceUsd,
        marketCapSol: sample.marketCapSol,
        marketCapUsd: sample.marketCapUsd,
        lastSlot: sample.slot > 0 ? sample.slot : undefined,
        priceUpdatedAtMs: sample.sampledAtMs,
        updatedAtMs: sample.sampledAtMs,
      }),
  );

  state.lastPriceAtMs = sample.sampledAtMs;
  state.lastError = null;
  store.set(state);

  counters.priceUpdates++;
  counters.lastPriceAtMs = sample.sampledAtMs;
  counters.lastMint = state.mint;
}

async function catchUpHistoryOne(
  config: PumpSwapConfig,
  state: PumpSwapPoolState,
  validator: CanonicalPoolValidator,
  solUsd: SolUsdOracle,
  counters: PumpSwapCounters,
): Promise<void> {
  if (!state.pool) return;

  let paginationToken: string | null = null;
  let scannedSlot = state.lastHistorySlot;
  const currentSolUsd = await solUsd.get();

  for (let pageIndex = 0; pageIndex < config.historyMaxPages; pageIndex++) {
    counters.historyRequests++;

    const page = await getTransactionsForAddress(config, state.mint, {
      afterSlot: state.lastHistorySlot,
      limit: config.historyLimit,
      paginationToken,
    });

    counters.historyTransactions += page.data.length;
    if (page.data.length === 0) break;

    const candidates: PumpSwapCandidate[] = [];

    for (const transaction of page.data) {
      const normalized = normalizeTransactionNotification(transaction);
      if (!normalized) continue;

      scannedSlot = Math.max(scannedSlot, normalized.slot);

      for (const candidate of extractPumpSwapCandidates(
        normalized,
        config.programId,
      )) {
        if (
          candidate.baseMint !== state.mint ||
          candidate.pool !== state.pool ||
          !supportedQuote(candidate.quoteMint)
        ) {
          continue;
        }

        const canonical = await validator.validate(
          candidate.pool,
          candidate.baseMint,
          candidate.quoteMint,
        );

        if (canonical) candidates.push(candidate);
        else counters.nonCanonicalPools++;
      }
    }

    candidates.sort(
      (left, right) =>
        left.slot - right.slot || left.tradedAtMs - right.tradedAtMs,
    );

    for (const candidate of candidates) {
      await persistCandidate(state, candidate, currentSolUsd, counters);
    }

    if (!page.paginationToken) break;
    paginationToken = page.paginationToken;
  }

  state.lastHistorySlot = Math.max(state.lastHistorySlot, scannedSlot);
  state.lastHistoryAtMs = Date.now();
}

async function catchUpHistory(
  config: PumpSwapConfig,
  store: PumpSwapStateStore,
  validator: CanonicalPoolValidator,
  solUsd: SolUsdOracle,
  counters: PumpSwapCounters,
): Promise<void> {
  if (config.historyMs <= 0) return;

  const now = Date.now();
  const due = store
    .values()
    .filter(
      (state) =>
        state.pool != null &&
        now - (state.lastHistoryAtMs ?? 0) >= config.historyMs,
    )
    .sort(
      (left, right) =>
        (left.lastHistoryAtMs ?? 0) - (right.lastHistoryAtMs ?? 0),
    )
    .slice(0, config.historyTokensPerCycle);

  await mapWithConcurrency(due, config.rpcConcurrency, async (state) => {
    try {
      await catchUpHistoryOne(config, state, validator, solUsd, counters);
      state.lastError = null;
    } catch (error) {
      counters.errors++;
      state.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      store.set(state);
    }
  });
}

function statusPayload(
  config: PumpSwapConfig,
  counters: PumpSwapCounters,
): Record<string, unknown> {
  return {
    rpc: redactedUrl(config.rpcUrl),
    ws: redactedUrl(config.wsUrl),
    statePath: config.statePath,
    lifecycleRefreshMs: config.lifecycleRefreshMs,
    subscriptionFlushMs: config.subscriptionFlushMs,
    repairPollMs: config.repairPollMs,
    discoveryRefreshMs: config.discoveryRefreshMs,
    historyMs: config.historyMs,
    maxConnections: config.maxConnections,
    maxSubscriptionsPerConnection: config.maxSubscriptionsPerConnection,
    maxTrackedTokens: config.maxTrackedTokens,
    capacity: config.maxConnections * config.maxSubscriptionsPerConnection,
    ...counters,
  };
}

export async function runPumpSwapIndexer(): Promise<void> {
  const config = loadPumpSwapConfig();
  const counters = createCounters();
  const controller = new AbortController();
  const store = new PumpSwapStateStore(config.statePath);
  const validator = new CanonicalPoolValidator(config);
  const solUsd = new SolUsdOracle(config);
  const subscriptions = new PumpSwapSubscriptionManager(
    config,
    counters,
    solUsd,
    async (sample) => persistReserveSample(store, sample, counters),
    (state) => store.set(state),
  );

  subscriptions.start(controller.signal);

  let stopping = false;

  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    subscriptions.stop();
    controller.abort();
    store.save();

    void writeStatus({
      name: config.name,
      kind: "indexer",
      status: "stopped",
      buildId: config.buildId,
      heartbeatAtMs: Date.now(),
      dataJson: JSON.stringify({ reason, ...statusPayload(config, counters) }),
      updatedAtMs: Date.now(),
    }).catch(() => undefined);
  };

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  const heartbeat = setInterval(() => {
    void writeStatus({
      name: config.name,
      kind: "indexer",
      status: "running",
      buildId: config.buildId,
      heartbeatAtMs: Date.now(),
      error: null,
      dataJson: JSON.stringify(statusPayload(config, counters)),
      updatedAtMs: Date.now(),
    }).catch((error) => {
      console.error("[solard:pumpswap] heartbeat failed", error);
    });
  }, config.heartbeatMs);
  (heartbeat as any).unref?.();

  await writeStatus({
    name: config.name,
    kind: "indexer",
    status: "starting",
    buildId: config.buildId,
    heartbeatAtMs: Date.now(),
    dataJson: JSON.stringify(statusPayload(config, counters)),
    updatedAtMs: Date.now(),
  });

  let nextLifecycleAtMs = 0;
  let nextDiscoveryAtMs = 0;
  let nextHistoryAtMs = 0;

  try {
    while (!controller.signal.aborted) {
      const now = Date.now();

      try {
        if (now >= nextLifecycleAtMs) {
          const tracked = reconcileTrackedTokens(config, store, counters);
          counters.trackedTokens = tracked.length;

          subscriptions.reconcile(store.values());
          counters.trackedPools = store
            .values()
            .filter((state) => state.pool).length;
          counters.cycles++;
          nextLifecycleAtMs = Date.now() + config.lifecycleRefreshMs;
        }

        if (now >= nextDiscoveryAtMs) {
          await discoverPools(config, store, validator, solUsd, counters);
          subscriptions.reconcile(store.values());
          counters.trackedPools = store
            .values()
            .filter((state) => state.pool).length;
          nextDiscoveryAtMs = Date.now() + config.discoveryRefreshMs;
        }

        if (config.historyMs > 0 && now >= nextHistoryAtMs) {
          await catchUpHistory(config, store, validator, solUsd, counters);
          nextHistoryAtMs = Date.now() + config.historyMs;
        }

        store.save();
      } catch (error) {
        counters.errors++;
        console.error("[solard:pumpswap] lifecycle cycle failed", error);

        await writeStatus({
          name: config.name,
          kind: "indexer",
          status: "error",
          buildId: config.buildId,
          heartbeatAtMs: Date.now(),
          error: error instanceof Error ? error.message : String(error),
          dataJson: JSON.stringify(statusPayload(config, counters)),
          updatedAtMs: Date.now(),
        }).catch(() => undefined);
      }

      const nextDue = Math.min(
        nextLifecycleAtMs || Date.now() + 500,
        nextDiscoveryAtMs || Date.now() + 500,
        config.historyMs > 0
          ? nextHistoryAtMs || Date.now() + 500
          : Number.POSITIVE_INFINITY,
      );

      await sleep(
        Math.max(100, Math.min(500, nextDue - Date.now())),
        controller.signal,
      );
    }
  } finally {
    subscriptions.stop();
    clearInterval(heartbeat);
    store.save();

    await writeStatus({
      name: config.name,
      kind: "indexer",
      status: "stopped",
      buildId: config.buildId,
      heartbeatAtMs: Date.now(),
      dataJson: JSON.stringify(statusPayload(config, counters)),
      updatedAtMs: Date.now(),
    }).catch(() => undefined);
  }
}

if (import.meta.main) {
  await runPumpSwapIndexer();
}
