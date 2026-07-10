/**
 * Streams Pump.fun logs from Helius logsSubscribe into the terminal store.
 *
 * Key env: HELIUS_API_KEY / HELIUS_RPC_URL / SOLARD_HELIUS_LOGS_WS_URL,
 * SOLARD_HELIUS_LOGS_CONCURRENCY, SOLARD_HELIUS_LOGS_MAX_QUEUED,
 * SOLARD_HELIUS_LOGS_HEARTBEAT_MS, SOLARD_HELIUS_LOGS_INDICATOR_FLUSH_MS.
 */

import {
  dbWrite,
  insertTerminalTrade,
  recomputeTerminalIndicators,
  upsertProcessStatus,
  upsertTerminalToken,
} from "../db/terminal-store.js";
import { recordWorkerError } from "../db/terminal-ingestion.js";
import {
  fetchHeliusAssetMetadata,
  fetchUriMetadata,
} from "../helius/token-metadata.js";
import { parsePumpLogs } from "../helius/pump-log-events.js";
import { PUMPFUN_PROGRAM_ID } from "../pump/pump-parser.js";
import {
  BoundedAsyncQueue,
  TtlDeduper,
  compactError,
  shortSignature,
} from "../pump/stream-utils.js";
import { resolveSolUsd } from "../prices/sol-usd.js";
import { workerMeasure as m } from "../measure.js";

const WORKER = "solard-helius-logs-v1";
const BUILD_ID = "helius-logs-v1-standard-logs-subscribe";

const COMMITMENT = (process.env.SOLARD_HELIUS_LOGS_COMMITMENT ??
  process.env.SOLARD_HELIUS_COMMITMENT ??
  "processed") as "processed" | "confirmed" | "finalized";

const CONCURRENCY = Math.max(
  1,
  Math.min(32, Number(process.env.SOLARD_HELIUS_LOGS_CONCURRENCY ?? "8")),
);

const MAX_QUEUED = Math.max(
  100,
  Number(process.env.SOLARD_HELIUS_LOGS_MAX_QUEUED ?? "5000"),
);

const DEDUPE_TTL_MS = Math.max(
  10_000,
  Number(process.env.SOLARD_HELIUS_LOGS_DEDUPE_TTL_MS ?? "120000"),
);

const INDICATOR_FLUSH_MS = Math.max(
  50,
  Number(process.env.SOLARD_HELIUS_LOGS_INDICATOR_FLUSH_MS ?? "250"),
);

const HEARTBEAT_MS = Math.max(
  1_000,
  Number(process.env.SOLARD_HELIUS_LOGS_HEARTBEAT_MS ?? "3000"),
);

const CIRCUIT_BREAKER_MIN_RECEIVED = Math.max(
  10,
  Number(process.env.SOLARD_HELIUS_LOGS_CIRCUIT_MIN_RECEIVED ?? "200"),
);

const CIRCUIT_BREAKER_ERROR_RATE = Math.min(
  1,
  Math.max(
    0,
    Number(process.env.SOLARD_HELIUS_LOGS_CIRCUIT_ERROR_RATE ?? "0.25"),
  ),
);

let running = true;
let lastSessionErrorRate = 0;
let lastSessionReceived = 0;

function apiKeyFromUrl(url: string | null | undefined): string | null {
  const match = String(url ?? "").match(/[?&](?:api-key|apiKey)=([^&]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function heliusWsUrl(): string {
  const explicit =
    process.env.SOLARD_HELIUS_LOGS_WS_URL?.trim() ||
    process.env.SOLARD_HELIUS_WS_URL?.trim() ||
    process.env.HELIUS_WS_URL?.trim();

  if (explicit) return explicit;

  const rpc =
    process.env.HELIUS_RPC_URL?.trim() ||
    process.env.RPC_ENDPOINT?.trim() ||
    process.env.SOLANA_RPC_URL?.trim() ||
    "";

  if (/^https:\/\//i.test(rpc) && /helius-rpc\.com/i.test(rpc)) {
    return rpc.replace(/^https:/i, "wss:");
  }

  if (/^http:\/\//i.test(rpc) && /helius-rpc\.com/i.test(rpc)) {
    return rpc.replace(/^http:/i, "ws:");
  }

  const key = process.env.HELIUS_API_KEY?.trim() || apiKeyFromUrl(rpc);

  if (key) {
    return `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  }

  throw new Error(
    "Missing Helius WebSocket config. Set HELIUS_API_KEY, HELIUS_RPC_URL, SOLARD_HELIUS_WS_URL, or HELIUS_WS_URL.",
  );
}

function redactUrl(value: string): string {
  return value.replace(/(api-key|apiKey)=([^&]+)/i, "$1=<redacted>");
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function eventData(event: MessageEvent<unknown> | { data?: unknown }): string {
  const data = event?.data;

  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }

  if (Buffer.isBuffer(data)) return data.toString("utf8");

  return String(data ?? "");
}

function confidence(): "processed" | "confirmed" | "finalized" | "dropped" {
  return COMMITMENT === "finalized"
    ? "finalized"
    : COMMITMENT === "confirmed"
      ? "confirmed"
      : "processed";
}

type LogJob = {
  signature: string;
  slot: number;
  logs: string[];
  receivedAtMs: number;
};

type HeliusLogsRpcMessage = {
  id?: unknown;
  result?: unknown;
  method?: unknown;
  params?: {
    result?: {
      context?: {
        slot?: unknown;
      };
      value?: {
        err?: unknown;
        signature?: unknown;
        logs?: unknown;
      };
    };
  };
};

type Counters = {
  received: number;
  accepted: number;
  duplicates: number;
  malformed: number;
  creates: number;
  trades: number;
  completes: number;
  imaged: number;
  errors: number;
  hydrationErrors: number;
  lastJobProcessingMs: number | null;
  avgJobProcessingMs: number | null;
  lastSignature: string | null;
  lastMint: string | null;
  lastMcapUsd: number | null;
  lastHydrationError: string | null;
  lastMessageAtMs: number;
  lastRaw: Record<string, unknown> | null;
};

const dirtyIndicatorMints = new Set<string>();
let indicatorFlushTimer: ReturnType<typeof setTimeout> | null = null;
let indicatorFlushInFlight = false;

function markIndicatorsDirty(mint: string): void {
  dirtyIndicatorMints.add(mint);
  scheduleIndicatorFlush();
}

function scheduleIndicatorFlush(): void {
  if (indicatorFlushTimer) return;
  indicatorFlushTimer = setTimeout(() => {
    void flushIndicators();
  }, INDICATOR_FLUSH_MS);
}

async function flushIndicators(): Promise<void> {
  indicatorFlushTimer = null;

  if (indicatorFlushInFlight) {
    scheduleIndicatorFlush();
    return;
  }

  const mints = Array.from(dirtyIndicatorMints);
  dirtyIndicatorMints.clear();

  if (mints.length === 0) return;

  indicatorFlushInFlight = true;

  try {
    await dbWrite("helius_logs_indicators_flush", () => {
      const now = Date.now();
      for (const mint of mints) {
        recomputeTerminalIndicators(mint, now);
      }
      return { mints: mints.length };
    });
  } catch (error) {
    for (const mint of mints) dirtyIndicatorMints.add(mint);
    recordWorkerError(WORKER, error, {
      phase: "indicator-flush",
      mints: mints.slice(0, 25),
      mintCount: mints.length,
    });
  } finally {
    indicatorFlushInFlight = false;
    if (dirtyIndicatorMints.size > 0) scheduleIndicatorFlush();
  }
}

function observeJobProcessing(counters: Counters, elapsedMs: number): void {
  counters.lastJobProcessingMs = elapsedMs;
  counters.avgJobProcessingMs =
    counters.avgJobProcessingMs == null
      ? elapsedMs
      : counters.avgJobProcessingMs * 0.9 + elapsedMs * 0.1;
}

function oldestQueuedJobAgeMs(
  queuedJobReceivedAtMs: Map<string, number>,
): number | null {
  const oldest = Math.min(...queuedJobReceivedAtMs.values());
  return Number.isFinite(oldest) ? Date.now() - oldest : null;
}

const tradeMetadataAttempts = new Map<string, number>();

function shouldHydrateTradeMint(mint: string): boolean {
  const now = Date.now();
  const last = tradeMetadataAttempts.get(mint) ?? 0;
  const ttl = Number(process.env.SOLARD_TRADE_METADATA_RETRY_MS ?? "120000");

  if (now - last < ttl) return false;

  tradeMetadataAttempts.set(mint, now);

  if (tradeMetadataAttempts.size > 5000) {
    for (const [key, value] of tradeMetadataAttempts) {
      if (now - value > ttl * 4) {
        tradeMetadataAttempts.delete(key);
      }
    }
  }

  return true;
}

function hasMetadata(value: Record<string, unknown>): boolean {
  return [
    "name",
    "symbol",
    "image",
    "description",
    "website",
    "twitter",
    "telegram",
  ].some((key) => {
    const item = value[key];
    return typeof item === "string" && item.trim().length > 0;
  });
}

async function hydrateTradeMint(mint: string): Promise<{ imaged: boolean }> {
  if (!shouldHydrateTradeMint(mint)) {
    return { imaged: false };
  }

  return await m(`hydrate_trade_mint:${mint}`, async () => {
    const assetMeta = await fetchHeliusAssetMetadata(mint);

    if (!hasMetadata(assetMeta as Record<string, unknown>)) {
      return { imaged: false };
    }

    await dbWrite("helius_logs_trade_metadata", () =>
      upsertTerminalToken({
        mint,
        symbol: assetMeta.symbol,
        name: assetMeta.name,
        image: assetMeta.image ?? undefined,
        description: assetMeta.description ?? undefined,
        website: assetMeta.website ?? undefined,
        twitter: assetMeta.twitter ?? undefined,
        telegram: assetMeta.telegram ?? undefined,
        updatedAtMs: Date.now(),
      }),
    );

    return {
      imaged: !!assetMeta.image,
    };
  });
}

async function applyCreateEvents(
  job: LogJob,
  creates: ReturnType<typeof parsePumpLogs>["creates"],
  counters: Counters,
): Promise<number> {
  let imaged = 0;

  for (const create of creates) {
    await m(`create:${create.mint}`, async () => {
      const [uriMeta, assetMeta] = await Promise.all([
        fetchUriMetadata(create.uri),
        fetchHeliusAssetMetadata(create.mint),
      ]);

      const merged = { ...assetMeta, ...uriMeta };

      await dbWrite("helius_logs_create", () =>
        upsertTerminalToken({
          mint: create.mint,
          symbol: merged.symbol ?? create.symbol ?? "",
          name: merged.name ?? create.name ?? create.symbol ?? create.mint,
          image: merged.image ?? null,
          uri: create.uri,
          description: merged.description ?? null,
          website: merged.website ?? null,
          twitter: merged.twitter ?? null,
          telegram: merged.telegram ?? null,
          creator: create.creator,
          bondingCurveKey: create.bondingCurveKey,
          source: "helius-logs-create",
          phase: "pump",
          isMayhemMode: create.isMayhemMode === true ? 1 : 0,
          supplyUi: 1_000_000_000,
          lastSlot: create.slot,
          signature: create.signature,
          createdAtMs: job.receivedAtMs,
          updatedAtMs: Date.now(),
        }),
      );

      if (merged.image) imaged++;
      counters.lastMint = create.mint;

      return {
        mint: create.mint,
        symbol: merged.symbol ?? create.symbol ?? null,
        hasImage: !!merged.image,
      };
    });
  }

  return imaged;
}

async function applyTradeEvents(
  trades: ReturnType<typeof parsePumpLogs>["trades"],
  counters: Counters,
): Promise<number> {
  let imaged = 0;

  for (const trade of trades) {
    await m(`trade:${trade.mint}`, async () => {
      const hydrated = await hydrateTradeMint(trade.mint).catch((error) => {
        counters.hydrationErrors++;
        counters.lastHydrationError = compactError(error);
        recordWorkerError(WORKER, error, {
          phase: "trade-metadata",
          mint: trade.mint,
        });
        return { imaged: false };
      });

      if (hydrated.imaged) imaged++;

      await dbWrite("helius_logs_trade_apply", () => {
        insertTerminalTrade({
          id: trade.id,
          mint: trade.mint,
          signature: trade.signature,
          slot: trade.slot,
          owner: trade.owner,
          side: trade.side,
          tokenDeltaUi: trade.tokenDeltaUi,
          solDeltaUi: trade.solDeltaUi,
          priceSol: trade.priceSol,
          priceUsd: trade.priceUsd,
          marketCapUsd: trade.marketCapUsd,
          confidence: confidence(),
          source: "helius-logs-trade",
          rawJson: json(trade.raw),
          createdAtMs: trade.createdAtMs,
          updatedAtMs: Date.now(),
        });

        upsertTerminalToken({
          mint: trade.mint,
          source: "helius-logs-trade",
          priceSol: trade.priceSol ?? undefined,
          priceUsd: trade.priceUsd ?? undefined,
          marketCapSol:
            trade.priceSol != null ? trade.priceSol * 1_000_000_000 : undefined,
          marketCapUsd: trade.marketCapUsd ?? undefined,
          lastSlot: trade.slot,
          signature: trade.signature,
          updatedAtMs: Date.now(),
        });

        return { mint: trade.mint, tradeId: trade.id };
      });

      markIndicatorsDirty(trade.mint);

      counters.lastMint = trade.mint;
      counters.lastMcapUsd = trade.marketCapUsd ?? counters.lastMcapUsd;

      return {
        mint: trade.mint,
        side: trade.side,
        marketCapUsd: trade.marketCapUsd,
        imaged: hydrated.imaged,
      };
    });
  }

  return imaged;
}

async function applyCompleteEvents(
  completes: ReturnType<typeof parsePumpLogs>["completes"],
): Promise<void> {
  for (const complete of completes) {
    await m(`complete:${complete.mint}`, async () => {
      await dbWrite("helius_logs_complete", () =>
        upsertTerminalToken({
          mint: complete.mint,
          source: "helius-logs-complete",
          phase: "migrated",
          lastSlot: complete.slot,
          signature: complete.signature,
          updatedAtMs: Date.now(),
        }),
      );

      return {
        mint: complete.mint,
        slot: complete.slot,
      };
    });
  }
}

async function applyLogJob(job: LogJob, counters: Counters): Promise<void> {
  await m(
    {
      start: () => `job:${shortSignature(job.signature)}`,
      catch: (error) => {
        counters.errors++;

        recordWorkerError(WORKER, error, {
          signature: job.signature,
          slot: job.slot,
        });

        return {
          error: compactError(error),
          signature: shortSignature(job.signature),
          slot: job.slot,
        };
      },
    },
    async () => {
      const solUsd = await resolveSolUsd();

      const parsed = parsePumpLogs({
        logs: job.logs,
        signature: job.signature,
        slot: job.slot,
        solUsd,
        now: job.receivedAtMs,
      });

      const createImages = await applyCreateEvents(
        job,
        parsed.creates,
        counters,
      );
      const tradeImages = await applyTradeEvents(parsed.trades, counters);

      await applyCompleteEvents(parsed.completes);

      const imaged = createImages + tradeImages;

      counters.creates += parsed.creates.length;
      counters.trades += parsed.trades.length;
      counters.completes += parsed.completes.length;
      counters.imaged += imaged;

      return {
        signature: shortSignature(job.signature),
        rawProgramData: parsed.rawProgramData,
        creates: parsed.creates.length,
        trades: parsed.trades.length,
        completes: parsed.completes.length,
        imaged,
        solUsd,
      };
    },
  );
}

function createCounters(): Counters {
  return {
    received: 0,
    accepted: 0,
    duplicates: 0,
    malformed: 0,
    creates: 0,
    trades: 0,
    completes: 0,
    imaged: 0,
    errors: 0,
    hydrationErrors: 0,
    lastJobProcessingMs: null,
    avgJobProcessingMs: null,
    lastSignature: null,
    lastMint: null,
    lastMcapUsd: null,
    lastHydrationError: null,
    lastMessageAtMs: 0,
    lastRaw: null,
  };
}

function heartbeat(
  attempt: number,
  redactedUrl: string,
  subscribed: boolean,
  subscriptionId: unknown,
  counters: Counters,
  dedupe: TtlDeduper,
  queue: BoundedAsyncQueue<LogJob>,
  queuedJobReceivedAtMs: Map<string, number>,
): void {
  const queueStats = queue.stats();
  const queueLagMs = oldestQueuedJobAgeMs(queuedJobReceivedAtMs);
  const errorRate = counters.errors / Math.max(1, counters.received);
  const dedupeHitRate = counters.duplicates / Math.max(1, counters.received);

  lastSessionErrorRate = errorRate;
  lastSessionReceived = counters.received;

  upsertProcessStatus({
    name: WORKER,
    kind: "stream",
    status: subscribed ? "ok" : "connecting",
    data: {
      source: "helius",
      buildId: BUILD_ID,
      mode: "logsSubscribe",
      transport: "helius-standard-websocket",
      url: redactedUrl,
      commitment: COMMITMENT,
      programId: PUMPFUN_PROGRAM_ID,
      attempt,
      subscribed,
      subscriptionId,
      ...counters,
      heartbeatMs: HEARTBEAT_MS,
      indicatorFlushMs: INDICATOR_FLUSH_MS,
      lastMessageAgeMs: counters.lastMessageAtMs
        ? Date.now() - counters.lastMessageAtMs
        : null,
      queueLagMs,
      avgJobProcessingMs: counters.avgJobProcessingMs,
      errorRate,
      dedupeHitRate,
      dedupeSize: dedupe.size(),
      queue: { ...queueStats, oldestJobAgeMs: queueLagMs },
    },
    error: counters.errors ? `${counters.errors} parser/write errors` : null,
  });
}

async function runSession(attempt: number): Promise<void> {
  await m.root(`session:${attempt}`, async () => {
    const url = heliusWsUrl();
    const redactedUrl = redactUrl(url);

    const dedupe = new TtlDeduper(DEDUPE_TTL_MS);
    const counters = createCounters();
    const queuedJobReceivedAtMs = new Map<string, number>();

    const queue = new BoundedAsyncQueue<LogJob>(
      async (job) => {
        queuedJobReceivedAtMs.delete(job.signature);
        const startedAtMs = Date.now();
        try {
          await applyLogJob(job, counters);
        } finally {
          observeJobProcessing(counters, Date.now() - startedAtMs);
        }
      },
      {
        concurrency: CONCURRENCY,
        maxQueued: MAX_QUEUED,
      },
    );

    const WebSocketCtor = globalThis.WebSocket;

    if (!WebSocketCtor) {
      throw new Error(
        "globalThis.WebSocket is unavailable in this Bun runtime",
      );
    }

    const ws = new WebSocketCtor(url);

    let subscribed = false;
    let subscriptionId: unknown = null;
    let lastHeartbeatAtMs = 0;

    const sendHeartbeat = (force = false) => {
      const now = Date.now();
      if (!force && now - lastHeartbeatAtMs < HEARTBEAT_MS) return;
      lastHeartbeatAtMs = now;

      heartbeat(
        attempt,
        redactedUrl,
        subscribed,
        subscriptionId,
        counters,
        dedupe,
        queue,
        queuedJobReceivedAtMs,
      );
    };

    const pulse = setInterval(sendHeartbeat, HEARTBEAT_MS);

    return await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        m.sync("ws_open", () => {
          const req = {
            jsonrpc: "2.0",
            id: 1,
            method: "logsSubscribe",
            params: [
              { mentions: [PUMPFUN_PROGRAM_ID] },
              { commitment: COMMITMENT },
            ],
          };

          ws.send(JSON.stringify(req));
          subscribed = true;
          sendHeartbeat(true);

          return {
            commitment: COMMITMENT,
            programId: PUMPFUN_PROGRAM_ID,
          };
        });
      });

      ws.addEventListener("message", (event: MessageEvent<unknown>) => {
        counters.received++;
        counters.lastMessageAtMs = Date.now();

        const raw = eventData(event);

        try {
          const data = JSON.parse(raw) as HeliusLogsRpcMessage;

          counters.lastRaw = {
            method: data?.method ?? null,
            id: data?.id ?? null,
            hasParams: !!data?.params,
            bytes: raw.length,
          };

          if (data?.id === 1 && data?.result != null) {
            subscriptionId = data.result;
            sendHeartbeat(true);
            return;
          }

          if (data?.method !== "logsNotification") {
            sendHeartbeat();
            return;
          }

          const value = data?.params?.result?.value ?? {};

          if (value?.err) {
            sendHeartbeat();
            return;
          }

          const signature = String(value?.signature ?? "");
          const logs = Array.isArray(value?.logs) ? value.logs.map(String) : [];
          const slot = Number(data?.params?.result?.context?.slot ?? 0);

          if (!signature || logs.length === 0) {
            counters.malformed++;
            sendHeartbeat();
            return;
          }

          counters.lastSignature = signature;

          if (!dedupe.add(signature)) {
            counters.duplicates++;
            sendHeartbeat();
            return;
          }

          const receivedAtMs = Date.now();
          if (
            queue.push({
              signature,
              logs,
              slot,
              receivedAtMs,
            })
          ) {
            counters.accepted++;
            queuedJobReceivedAtMs.set(signature, receivedAtMs);
          }

          sendHeartbeat();
        } catch (error) {
          counters.malformed++;
          counters.errors++;

          recordWorkerError(WORKER, error, {
            phase: "message",
            raw: raw.slice(0, 500),
          });

          sendHeartbeat(true);
        }
      });

      ws.addEventListener("close", () => {
        clearInterval(pulse);
        sendHeartbeat(true);
        resolve();
      });

      ws.addEventListener("error", (event: any) => {
        const error = new Error(
          String(event?.message ?? "Helius logs WebSocket error"),
        );

        recordWorkerError(WORKER, error, {
          phase: "websocket",
          url: redactedUrl,
        });

        upsertProcessStatus({
          name: WORKER,
          kind: "stream",
          status: "error",
          error,
          data: {
            source: "helius",
            buildId: BUILD_ID,
            mode: "logsSubscribe",
            url: redactedUrl,
          },
        });

        clearInterval(pulse);
        reject(error);
      });
    }).finally(() => {
      clearInterval(pulse);

      try {
        ws.close();
      } catch {}
    });
  });
}

async function main(): Promise<void> {
  let attempt = 0;

  while (running) {
    attempt++;

    await m(
      {
        start: () => "helius_logs_session",
        catch: (error) => {
          recordWorkerError(WORKER, error, { attempt });

          upsertProcessStatus({
            name: WORKER,
            kind: "stream",
            status: "error",
            error,
            data: {
              source: "helius",
              buildId: BUILD_ID,
              attempt,
            },
          });

          return {
            error: compactError(error),
            attempt,
          };
        },
      },
      () => runSession(attempt),
    );

    const baseDelay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
    const circuitBreakerDelay =
      lastSessionReceived >= CIRCUIT_BREAKER_MIN_RECEIVED &&
      lastSessionErrorRate >= CIRCUIT_BREAKER_ERROR_RATE
        ? baseDelay
        : 0;
    const delay = Math.min(60_000, baseDelay + circuitBreakerDelay);

    upsertProcessStatus({
      name: WORKER,
      kind: "stream",
      status: "reconnecting",
      data: {
        source: "helius",
        buildId: BUILD_ID,
        attempt,
        delay,
        baseDelay,
        circuitBreakerDelay,
        lastSessionErrorRate,
        lastSessionReceived,
      },
    });

    await Bun.sleep(delay);
  }
}

function stop(reason: string): void {
  running = false;

  m.sync(`stop:${reason}`, () => {
    upsertProcessStatus({
      name: WORKER,
      kind: "stream",
      status: "stopped",
      data: {
        source: "helius",
        reason,
        buildId: BUILD_ID,
      },
    });

    return {
      reason,
      buildId: BUILD_ID,
    };
  });

  process.exit(0);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

main().catch((error) => {
  m.sync("fatal", () => {
    recordWorkerError(WORKER, error, {
      phase: "fatal",
    });

    upsertProcessStatus({
      name: WORKER,
      kind: "stream",
      status: "fatal",
      error,
      data: {
        source: "helius",
        buildId: BUILD_ID,
      },
    });

    return error;
  });

  throw error;
});
