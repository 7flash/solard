import {
  listTelegramSignals,
  listTerminalFeed,
  listTerminalTrades,
  terminalStoreStats,
} from "../db/terminal-store.js";
import {
  listWorkerRuntimeStatus,
  resolveWorkerNames,
} from "../processes/bgrun.js";
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
      end: (result) => ({
        result: summarizeForMeasure(result),
      }),
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

      const tokens = listTerminalFeed({
        limit: 100,
        activeWindowMs: 24 * 60 * 60 * 1_000,
        includeUnpriced: true,
        source: input.source ?? "both",
      });

      const latestToken = tokens[0] ?? null;

      const latestPricedToken =
        tokens.find(
          (token) => token.marketCapUsd != null || token.priceUsd != null,
        ) ?? null;

      const latestImagedToken =
        tokens.find((token) => Boolean(token.image)) ?? null;

      const latestTrade =
        listTerminalTrades({
          limit: 1,
          source: input.source ?? "both",
        })[0] ?? null;

      const latestSignal = listTelegramSignals(1)[0] ?? null;

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

        latest: {
          token: latestToken,
          pricedToken: latestPricedToken,
          imagedToken: latestImagedToken,
          trade: latestTrade,
          signal: latestSignal,
        },

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
