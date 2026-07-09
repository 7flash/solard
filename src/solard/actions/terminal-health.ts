import {
  listProcessStatus,
  terminalStoreStats,
  terminalDb,
} from "../db/terminal-store.js";
import { resolveWorkerNames } from "../processes/bgrun.js";
import {
  listWorkerErrors,
  terminalIngestionStats,
} from "../db/terminal-ingestion.js";
import { solUsdCacheState } from "../prices/sol-usd.js";
import { cliMeasure, summarizeForMeasure } from "../measure.js";

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
      const now = Date.now();
      const processes = listProcessStatus().map((row) => ({
        ...row,
        ageMs: now - Number(row.heartbeatAtMs || 0),
        stale: now - Number(row.heartbeatAtMs || 0) > staleMs,
      }));
      const currentWorkers = resolveWorkerNames({
        source: input.source,
        telegram: process.env.SOLARD_TELEGRAM_SIGNALS === "1",
      });
      const latest = {
        token:
          terminalDb.raw<any>(
            "SELECT mint, symbol, name, image, marketCapUsd, priceUsd, source, updatedAtMs FROM terminalTokensLive ORDER BY updatedAtMs DESC LIMIT 1",
          )[0] ?? null,
        pricedToken:
          terminalDb.raw<any>(
            "SELECT mint, symbol, name, image, marketCapUsd, priceUsd, source, updatedAtMs FROM terminalTokensLive WHERE marketCapUsd IS NOT NULL OR priceUsd IS NOT NULL ORDER BY updatedAtMs DESC LIMIT 1",
          )[0] ?? null,
        imagedToken:
          terminalDb.raw<any>(
            "SELECT mint, symbol, name, image, marketCapUsd, priceUsd, source, updatedAtMs FROM terminalTokensLive WHERE image IS NOT NULL AND image != '' ORDER BY updatedAtMs DESC LIMIT 1",
          )[0] ?? null,
        trade:
          terminalDb.raw<any>(
            "SELECT mint, side, marketCapUsd, priceUsd, createdAtMs FROM terminalTradesLive ORDER BY createdAtMs DESC LIMIT 1",
          )[0] ?? null,
        signal:
          terminalDb.raw<any>(
            "SELECT sourceName, text, receivedAtMs FROM telegramSignals ORDER BY receivedAtMs DESC LIMIT 1",
          )[0] ?? null,
      };
      return {
        ok: processes.every((row) => !row.stale && row.status !== "fatal"),
        staleMs,
        store: terminalStoreStats(),
        ingestion: terminalIngestionStats(),
        solUsd: solUsdCacheState(),
        processes,
        latest,
        errors: input.allErrors
          ? listWorkerErrors(null, input.errors ?? 20)
          : currentWorkers.flatMap((worker) =>
              listWorkerErrors(
                worker,
                Math.max(
                  1,
                  Math.ceil((input.errors ?? 20) / currentWorkers.length),
                ),
              ),
            ),
      };
    },
  );
}
