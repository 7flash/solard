import {
  terminalLatestActivity,
  terminalStoreStats,
} from "@solard/core/db.js";
import {
  listWorkerRuntimeStatus,
  resolveWorkerNames,
} from "../processes/bgrun.ts";
import {
  listWorkerErrors,
  terminalIngestionStats,
} from "../db/terminal-ingestion.ts";
import { solUsdCacheState } from "../prices/sol-usd.ts";
import { cliMeasure, summarizeForMeasure } from "../measure.ts";

export function terminalHealthAction(
  input: {
    staleMs?: number;
    errors?: number;
    source?: string | null;
    allErrors?: boolean;
  } = {},
): Record<string, unknown> {
  return cliMeasure.measureSync(
    {
      start: () => "terminal health",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    () => {
      const staleMs = Math.max(
        5_000,
        input.staleMs ?? Number(process.env.SOLARD_WORKER_STALE_MS ?? "15000"),
      );
      const currentWorkers = resolveWorkerNames({
        source: input.source,
        telegram: process.env.SOLARD_TELEGRAM_SIGNALS === "1",
      });
      const processes = listWorkerRuntimeStatus({
        source: input.source,
        telegram: process.env.SOLARD_TELEGRAM_SIGNALS === "1",
      }).map((row) => ({
        ...row,
        stale: row.stale || row.ageMs > staleMs,
      }));

      return {
        ok: processes.every(
          (row) =>
            row.managed &&
            !row.stale &&
            !row.buildMismatch &&
            row.status !== "fatal",
        ),
        staleMs,
        store: terminalStoreStats(),
        ingestion: terminalIngestionStats(),
        solUsd: solUsdCacheState(),
        processes,
        latest: terminalLatestActivity(),
        errors: input.allErrors
          ? listWorkerErrors(null, input.errors ?? 20)
          : currentWorkers.flatMap((worker) =>
              listWorkerErrors(
                worker,
                Math.max(
                  1,
                  Math.ceil(
                    (input.errors ?? 20) / Math.max(1, currentWorkers.length),
                  ),
                ),
              ),
            ),
      };
    },
  );
}
