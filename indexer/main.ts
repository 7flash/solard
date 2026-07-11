#!/usr/bin/env bun
import {
  SOLARD_DB_PATH,
  recordWorkerError,
  upsertProcessStatus,
} from "../shared/db.js";
import { loadConfig } from "./config.js";
import { runHeliusWsSession } from "./helius-ws.js";
import { indexerMeasure, summarizeError, summarizeValue } from "./measure.js";
import { startMetadataHydrator } from "./metadata.js";
import { startMayhemHydrator } from "./mayhem.js";
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

    duplicateTrades: 0,

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

export async function runIndexer(): Promise<void> {
  const config = loadConfig();

  const counters = createCounters();

  const controller = new AbortController();

  let stopping = false;

  const stop = (reason: string) => {
    if (stopping) {
      return;
    }

    stopping = true;

    controller.abort();
    stopMayhemHydrator?.();

    upsertProcessStatus({
      name: config.name,

      kind: "indexer",

      status: "stopped",

      buildId: config.buildId,

      dataJson: JSON.stringify({
        reason,
        dbPath: SOLARD_DB_PATH,
        ...counters,
      }),

      updatedAtMs: Date.now(),
    });
  };

  process.on("SIGINT", () => stop("SIGINT"));

  process.on("SIGTERM", () => stop("SIGTERM"));

  const sol = await refreshSolUsd({
    fallback: config.solUsd,

    force: true,

    timeoutMs: 2_500,
  }).catch(() => ({
    value: config.solUsd,
  }));

  counters.solUsd = sol.value ?? null;

  counters.solUsdAtMs = Date.now();

  startMetadataHydrator(config, counters);

  const stopMayhemHydrator = startMayhemHydrator(config, counters);

  upsertProcessStatus({
    name: config.name,

    kind: "indexer",

    status: "starting",

    buildId: config.buildId,

    dataJson: JSON.stringify({
      source: "helius",

      mode: "logsSubscribe",

      dbPath: SOLARD_DB_PATH,

      programId: config.programId,

      programIdSource: config.programIdSource,

      programIdCorrected: config.programIdCorrected,

      commitment: config.commitment,

      solUsd: counters.solUsd,

      metadataFetch: config.metadataFetch,

      mayhemFetch: config.mayhemFetch,

      rpcUrl: config.rpcUrl.replace(/(api[-_]?key=)[^&]+/i, "$1***"),
    }),

    updatedAtMs: Date.now(),
  });

  let attempt = 0;

  while (!stopping) {
    attempt++;

    await indexerMeasure.measure(
      {
        start: () => `indexer loop attempt=${attempt}`,

        end: summarizeValue,

        catch: (error) => {
          counters.errors++;

          recordWorkerError(config.name, error, {
            phase: "session",

            attempt,
          });

          upsertProcessStatus({
            name: config.name,

            kind: "indexer",

            status: "error",

            buildId: config.buildId,

            error: error instanceof Error ? error.message : String(error),

            dataJson: JSON.stringify({
              attempt,
              ...counters,
            }),

            updatedAtMs: Date.now(),
          });

          return summarizeError(error);
        },
      },
      async () =>
        await runHeliusWsSession({
          config,
          counters,
          attempt,
          signal: controller.signal,
        }),
    );

    if (stopping) {
      break;
    }

    const delay = Math.min(
      config.reconnectMaxMs,

      config.reconnectMinMs * 2 ** Math.min(attempt, 6),
    );

    upsertProcessStatus({
      name: config.name,

      kind: "indexer",

      status: "reconnecting",

      buildId: config.buildId,

      dataJson: JSON.stringify({
        delay,
        attempt,
        ...counters,
      }),

      updatedAtMs: Date.now(),
    });

    await sleep(delay);
  }
}

if (import.meta.main) {
  runIndexer().catch((error) => {
    console.error("[solard:indexer] fatal", error);

    process.exitCode = 1;
  });
}
