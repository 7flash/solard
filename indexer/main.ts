#!/usr/bin/env bun
import {
  pruneIngestionKeys,
  recordWorkerError,
  upsertProcessStatus,
} from "../shared/terminal-repo.js";
import { loadConfig } from "./config.js";
import { openIndexerDb } from "./db.js";
import { runHeliusWsSession } from "./helius-ws.js";
import { indexerMeasure, summarizeError, summarizeValue } from "./measure.js";
import { startMetadataHydrator } from "./metadata.js";
import { refreshSolUsd } from "./sol-usd.js";
import type { Counters } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createCounters(): Counters {
  return {
    sessions: 0,
    messages: 0,
    creates: 0,
    trades: 0,
    completes: 0,
    metadataQueued: 0,
    metadataHydrated: 0,
    metadataFailed: 0,
    skipped: 0,
    duplicates: 0,
    errors: 0,
    lastSignature: null,
    lastMint: null,
    lastMcapUsd: null,
    lastEventAtMs: null,
    solUsd: null,
    solUsdAtMs: null,
  };
}

export async function runIndexer(): Promise<void> {
  const config = loadConfig();
  const store = openIndexerDb();
  const counters = createCounters();
  const controller = new AbortController();

  let stopping = false;

  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    controller.abort();

    upsertProcessStatus(
      {
        name: config.name,
        kind: "indexer",
        status: "stopped",
        buildId: config.buildId,
        data: {
          reason,
          dbPath: store.path,
          ...counters,
        },
      },
      store.db,
    );

    setTimeout(() => process.exit(0), 50);
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  const sol = await refreshSolUsd({
    fallback: config.solUsd,
    force: true,
  }).catch(() => ({
    value: config.solUsd,
  }));

  counters.solUsd = sol.value ?? null;
  counters.solUsdAtMs = Date.now();

  startMetadataHydrator({
    db: store.db,
    config,
    counters,
  });

  upsertProcessStatus(
    {
      name: config.name,
      kind: "indexer",
      status: "starting",
      buildId: config.buildId,
      data: {
        dbPath: store.path,
        source: "helius",
        solUsd: counters.solUsd,
      },
    },
    store.db,
  );

  let attempt = 0;

  while (!stopping) {
    attempt++;

    await indexerMeasure.measure(
      {
        start: () => `indexer loop attempt=${attempt}`,
        end: summarizeValue,
        catch: (error) => {
          counters.errors++;

          recordWorkerError(
            config.name,
            error,
            {
              phase: "session",
              attempt,
            },
            store.db,
          );

          upsertProcessStatus(
            {
              name: config.name,
              kind: "indexer",
              status: "error",
              buildId: config.buildId,
              error,
              data: {
                attempt,
                ...counters,
              },
            },
            store.db,
          );

          return summarizeError(error);
        },
      },
      async () => {
        const result = await runHeliusWsSession({
          db: store.db,
          config,
          counters,
          attempt,
          signal: controller.signal,
        });

        const pruned = pruneIngestionKeys(
          "helius-indexer",
          Number(process.env.SOLARD_INDEXER_SEEN_RETENTION_MS ?? 21_600_000),
          store.db,
        );

        return { ...result, pruned };
      },
    );

    if (stopping) break;

    const delay = Math.min(
      config.reconnectMaxMs,
      config.reconnectMinMs * 2 ** Math.min(attempt, 6),
    );

    upsertProcessStatus(
      {
        name: config.name,
        kind: "indexer",
        status: "reconnecting",
        buildId: config.buildId,
        data: {
          delay,
          attempt,
          ...counters,
        },
      },
      store.db,
    );

    await sleep(delay);
  }

  store.close();
}

if (import.meta.main) {
  runIndexer().catch((error) => {
    console.error("[solard:indexer] fatal", error);
    process.exitCode = 1;
  });
}
