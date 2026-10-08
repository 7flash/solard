import type { Commitment } from "@solana/web3.js";
import type { TradeEvent } from "./launch-trades.ts";
import { openDatabase, closeDatabase, resolveDbPath } from "../db/database.ts";
import { SqliteTokenHistoryRepository } from "../chain/token-history/repository.ts";
import { buildSparseTokenHistoryCandles1s } from "../chain/token-history/candles.ts";
import type {
  TokenHistoryTrade,
  TokenHistoryRaw,
  TokenHistoryConfidence,
} from "../chain/token-history/types.ts";

export type LiveTradeHistoryOptions = {
  dbPath?: string;
  commitment?: Commitment;
  flushIntervalMs?: number;
  batchSize?: number;
  maxPending?: number;
  onStatus?: (event: string, data?: Record<string, unknown>) => void;
};
export type LiveTradeHistoryRecorder = {
  record(event: TradeEvent): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
/** Live prices are reserve spot observations, not transaction fill prices or wallet accounting. */
export function liveTradeHistoryRow(
  event: TradeEvent,
  commitment: Commitment = "processed",
): TokenHistoryTrade | null {
  if (
    !event.signature ||
    !event.mint ||
    !event.market?.quoteMint ||
    !event.side ||
    !Number.isSafeInteger(event.slot) ||
    event.slot < 0 ||
    !Number.isSafeInteger(event.atMs) ||
    event.atMs < 0
  )
    return null;
  const m = event.market;
  if (
    !Number.isInteger(m.baseDecimals) ||
    m.baseDecimals < 0 ||
    m.baseDecimals > 255 ||
    !Number.isInteger(m.quoteDecimals) ||
    m.quoteDecimals < 0 ||
    m.quoteDecimals > 255
  )
    return null;
  const eventIndex =
    Number.isSafeInteger(event.eventIndex) && event.eventIndex! >= 0
      ? event.eventIndex!
      : null;
  const identity =
    eventIndex == null
      ? `partial:${event.baseRaw ?? "unknown"}:${event.quoteRaw ?? "unknown"}`
      : String(eventIndex);
  const eventKey = [
    "live-trade-v1",
    event.signature,
    event.mint,
    event.venue,
    event.pool ?? "unknown",
    identity,
  ].join(":");
  const confidence: TokenHistoryConfidence =
    commitment === "finalized"
      ? "finalized"
      : commitment === "confirmed"
        ? "confirmed"
        : "processed";
  const sign = event.side === "buy" ? 1 : -1;
  const tokens =
    event.baseRaw == null ? 0 : Number(event.baseRaw) / 10 ** m.baseDecimals;
  // Custom-quote amounts are retained as quote units; a spot conversion is not
  // evidence of a user's actual SOL debit and is not fabricated as solDeltaUi.
  const native = m.quoteMint === "So11111111111111111111111111111111111111112";
  const sol =
    native && event.quoteRaw != null
      ? Number(event.quoteRaw) / 10 ** m.quoteDecimals
      : 0;
  const history: TokenHistoryRaw = {
    parserVersion: "live-trade-v1",
    venue:
      event.venue === "pump"
        ? "pump-curve"
        : event.venue === "pumpswap"
          ? "pumpswap"
          : event.venue === "meteora-dbc" || event.venue === "meteora-damm-v2"
            ? event.venue
            : "raydium",
    instructionKinds: [event.venue],
    instructionIndex: eventIndex ?? 0,
    historyOrder: eventIndex ?? 0,
    scanAddress: event.pool ?? event.mint,
    scanKind: event.venue === "pump" ? "curve" : "pool",
    ownerTokenDeltaRaw: "0",
    nativeWalletDeltaLamports: null,
    networkFeeLamports: "0",
    tokenAccountRentDeltaLamports: "0",
    wsolDeltaRaw: "0",
    economicQuoteDeltaLamports: null,
    pricingStatus:
      finite(m.priceSol) == null ? "missing" : "instruction-input-fallback",
    excludedExternalTransfersLamports: "0",
    marketCapSol: finite(m.marketCapSol),
  };
  const raw = {
    ...history,
    live: {
      venue: event.venue,
      pool: event.pool,
      quoteMint: m.quoteMint,
      baseDecimals: m.baseDecimals,
      quoteDecimals: m.quoteDecimals,
      supplyRaw: m.supplyRaw.toString(),
      baseReserveRaw: m.baseReserveRaw.toString(),
      quoteReserveRaw: m.quoteReserveRaw.toString(),
      baseRaw: event.baseRaw?.toString() ?? null,
      quoteRaw: event.quoteRaw?.toString() ?? null,
      eventIndex,
      confidence,
      collectionComplete: false,
      eventIdentityComplete: eventIndex != null,
      timestampSource: event.timestampSource ?? "observed",
      observedAtMs: Date.now(),
      priceKind: "reserve-spot",
      priceQuotePerToken: finite(m.priceQuotePerToken),
      priceSol: finite(m.priceSol),
      priceUsd: finite(m.priceUsd),
      networkFeeLamports: null,
      accountRentLamports: null,
      walletAccountingAvailable: false,
    },
  };
  return {
    eventKey,
    mint: event.mint,
    signature: event.signature,
    slot: event.slot,
    owner: null,
    side: event.side,
    tokenDeltaUi: Number.isFinite(tokens) ? sign * tokens : 0,
    solDeltaUi: Number.isFinite(sol) && sol > 0 ? -sign * sol : 0,
    priceSol: finite(m.priceSol),
    priceUsd: finite(m.priceUsd),
    marketCapUsd: finite(m.marketCapUsd),
    confidence,
    source: "live-trade-stream",
    rawJson: JSON.stringify(raw),
    tradedAtMs: event.atMs,
    updatedAtMs: Date.now(),
    history,
  };
}

type Writer = {
  refs: number;
  pending: Map<string, TokenHistoryTrade>;
  tail: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
  repository?: SqliteTokenHistoryRepository;
  path: string;
  options: LiveTradeHistoryOptions;
  batchSize: number;
  maxPending: number;
  flush(): Promise<void>;
};
const writers = new Map<string, Writer>();
function writerFor(options: LiveTradeHistoryOptions): Writer {
  const path = resolveDbPath(options.dbPath);
  const existing = writers.get(path);
  if (existing) {
    existing.refs++;
    return existing;
  }
  const batchSize = options.batchSize ?? 250,
    maxPending = options.maxPending ?? 1000,
    interval = options.flushIntervalMs ?? 1000;
  if (
    ![batchSize, maxPending, interval].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    batchSize > maxPending
  )
    throw new Error("Invalid live history batch/queue/flush limits");
  const writer: Writer = {
    path,
    options,
    refs: 1,
    pending: new Map(),
    tail: Promise.resolve(),
    batchSize,
    maxPending,
    flush() {
      const work = writer.tail.then(() => {
        if (!writer.pending.size) return;
        if (!writer.repository)
          writer.repository = new SqliteTokenHistoryRepository(
            openDatabase(path),
          );
        while (writer.pending.size) {
          const batch = [...writer.pending.values()].slice(0, writer.batchSize);
          const buckets = new Map<string, Set<number>>();
          for (const row of batch) {
            let set = buckets.get(row.mint);
            if (!set) {
              set = new Set();
              buckets.set(row.mint, set);
            }
            set.add(Math.floor(row.tradedAtMs / 1000) * 1000);
          }
          const result = writer.repository.persistLiveTrades(batch);
          const now = Date.now();
          for (const [mint, times] of buckets) {
            for (const from of times) {
              const rows = writer.repository.loadTradesInWindow(
                mint,
                from,
                from + 1000,
              );
              writer.repository.persistCandles1s(
                buildSparseTokenHistoryCandles1s(rows, now),
              );
            }
            const coverage = writer.repository.getCoverage(mint);
            if (coverage && result.inserted + result.updated > 0)
              writer.repository.saveCoverage({
                ...coverage,
                complete: false,
                priceTapeComplete: false,
                updatedAtMs: now,
              });
          }
          for (const row of batch)
            if (writer.pending.get(row.eventKey) === row)
              writer.pending.delete(row.eventKey);
          try {
            options.onStatus?.("history-persisted", {
              rows: batch.length,
              ...result,
              complete: false,
            });
          } catch {}
        }
      });
      writer.tail = work.catch(() => undefined);
      return work;
    },
  };
  writer.timer = setInterval(() => {
    void writer.flush().catch((error) => {
      try {
        options.onStatus?.("history-persistence-error", {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {}
    });
  }, interval);
  writer.timer.unref?.();
  writers.set(path, writer);
  return writer;
}

/** Creating a recorder does not open a database; the first flush does. */
export function createLiveTradeHistoryRecorder(
  options: LiveTradeHistoryOptions = {},
): LiveTradeHistoryRecorder {
  const writer = writerFor(options);
  let closed = false;
  const active = new Set<Promise<void>>();
  const enqueue = async (event: TradeEvent) => {
    const row = liveTradeHistoryRow(event, options.commitment);
    if (!row) {
      options.onStatus?.("history-event-skipped", {
        mint: event.mint,
        signature: event.signature,
      });
      return;
    }
    if (writer.pending.size >= writer.maxPending) await writer.flush();
    const previous = writer.pending.get(row.eventKey);
    const rank = { processed: 0, confirmed: 1, finalized: 2, dropped: -1 };
    if (!previous || rank[row.confidence] >= rank[previous.confidence])
      writer.pending.set(row.eventKey, row);
    if (writer.pending.size >= writer.batchSize) await writer.flush();
  };
  return {
    record(event) {
      if (closed)
        return Promise.reject(new Error("Live history recorder is closed"));
      const job = enqueue(event);
      active.add(job);
      void job.then(
        () => active.delete(job),
        () => active.delete(job),
      );
      return job;
    },
    flush: () => writer.flush(),
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...active]);
      try {
        await writer.flush();
      } catch (error) {
        closed = false;
        throw error;
      } // Retain queued rows and allow an explicit close retry.
      if (--writer.refs === 0) {
        if (writer.timer) clearInterval(writer.timer);
        writers.delete(writer.path);
        if (writer.repository) closeDatabase(writer.path);
      }
    },
  };
}
