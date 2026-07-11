#!/usr/bin/env bun
import { loadConfig, redactedUrl } from "./config.js";
import {
  openIndexerDb,
  pruneIngestionKeys,
  recordWorkerError,
  upsertProcessStatus,
} from "./db.js";
import { runHeliusWsSession } from "./helius-ws.js";
import { indexerMeasure, summarizeError, summarizeValue } from "./measure.js";
import type { Counters } from "./types.js";
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function counters(): Counters {
  return {
    sessions: 0,
    messages: 0,
    creates: 0,
    trades: 0,
    completes: 0,
    skipped: 0,
    duplicates: 0,
    errors: 0,
    lastSignature: null,
    lastMint: null,
    lastMcapUsd: null,
    lastEventAtMs: null,
  };
}
export async function runIndexer(): Promise<void> {
  const config = loadConfig();
  const store = openIndexerDb(config.dbPath);
  const count = counters();
  const controller = new AbortController();
  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    upsertProcessStatus(store.db, {
      name: config.name,
      kind: "indexer",
      status: "stopped",
      buildId: config.buildId,
      data: { reason, ...count },
    });
    setTimeout(() => process.exit(0), 50);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  upsertProcessStatus(store.db, {
    name: config.name,
    kind: "indexer",
    status: "starting",
    buildId: config.buildId,
    data: {
      source: "helius",
      mode: "logsSubscribe",
      dbPath: config.dbPath,
      url: redactedUrl(config.wsUrl),
      programId: config.programId,
      commitment: config.commitment,
      solUsd: config.solUsd,
      metadataFetch: config.metadataFetch,
    },
  });
  let attempt = 0;
  while (!stopping) {
    attempt++;
    await indexerMeasure.measure(
      {
        start: () => `indexer loop attempt=${attempt}`,
        end: summarizeValue,
        catch: (error) => {
          count.errors++;
          recordWorkerError(store.db, config.name, error, {
            phase: "session",
            attempt,
          });
          upsertProcessStatus(store.db, {
            name: config.name,
            kind: "indexer",
            status: "error",
            buildId: config.buildId,
            error,
            data: { attempt, ...count },
          });
          return summarizeError(error);
        },
      },
      async () => {
        const result = await runHeliusWsSession({
          db: store.db,
          config,
          counters: count,
          attempt,
          signal: controller.signal,
        });
        const pruned = pruneIngestionKeys(
          store.db,
          "helius-indexer",
          Number(process.env.SOLARD_INDEXER_SEEN_RETENTION_MS ?? "21600000"),
        );
        return { ...result, pruned };
      },
    );
    if (stopping) break;
    const delay = Math.min(
      config.reconnectMaxMs,
      config.reconnectMinMs * 2 ** Math.min(attempt, 6),
    );
    upsertProcessStatus(store.db, {
      name: config.name,
      kind: "indexer",
      status: "reconnecting",
      buildId: config.buildId,
      data: { delay, attempt, ...count },
    });
    await sleep(delay);
  }
  store.close();
}
if (import.meta.main)
  runIndexer().catch((error) => {
    console.error("[solard:indexer] fatal", error);
    process.exitCode = 1;
  });
