import {
  ensureWorkerGroup,
  listWorkerRuntimeStatus,
  normalizeStreamSource,
} from "../processes/bgrun.ts";
import {
  insertTerminalProbeRow,
  listTerminalFeed,
  terminalStoreStats,
} from "@solard/core/db.js";
import { listWorkerErrors } from "../db/terminal-ingestion.ts";
import { cliMeasure, summarizeForMeasure } from "../measure.ts";

export async function terminalProbeAction(
  input: {
    source?: string | null;
    inject?: boolean;
    ensure?: boolean;
    restartStale?: boolean;
    limit?: number;
  } = {},
): Promise<Record<string, unknown>> {
  return await cliMeasure.measure(
    {
      start: () => `terminal source probe ${input.source ?? "default"}`,
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      const source = normalizeStreamSource(input.source);
      const ensure =
        input.ensure === false
          ? null
          : await ensureWorkerGroup({
              source,
              restartStale: input.restartStale !== false,
            });
      const injected =
        input.inject === true ? insertTerminalProbeRow({ source }) : null;
      const rows = listTerminalFeed({
        source,
        limit: input.limit ?? 20,
        activeWindowMs: 5 * 60_000,
        includeUnpriced: true,
      });
      const workers = listWorkerRuntimeStatus({ source });
      const errors = listWorkerErrors({
        workers: workers.map((row) => row.name),
        limit: 8,
      });
      return {
        ok: rows.length > 0 || !!injected,
        source,
        injected: !!injected,
        ensure,
        workers,
        rows,
        stats: terminalStoreStats(),
        errors,
      };
    },
  );
}
