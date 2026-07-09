import { ensureWorkerGroup } from "../processes/bgrun.js";
import { listTerminalFeed, terminalStoreStats } from "../db/terminal-store.js";
import { cliMeasure, summarizeForMeasure } from "../measure.js";
import {
  formatProcessSummary,
  formatTerminalFeedRow,
} from "../terminal/presenter.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function terminalFeedSnapshotAction(
  input: {
    limit?: number;
    sinceMs?: number;
    source?: string | null;
  } = {},
): Promise<Record<string, unknown>> {
  return await cliMeasure.measure(
    {
      start: () => "terminal feed snapshot",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      const rows = listTerminalFeed({
        limit: input.limit ?? 250,
        sinceMs: input.sinceMs ?? 0,
        includeUnpriced: String(
          input.source ?? process.env.SOLARD_STREAM_SOURCE ?? "helius",
        ).includes("helius"),
        source: input.source ?? process.env.SOLARD_STREAM_SOURCE ?? "helius",
      });
      return {
        source: input.source ?? process.env.SOLARD_STREAM_SOURCE ?? "helius",
        rows,
        stats: terminalStoreStats(),
      };
    },
  );
}

export async function followTerminalFeedAction(
  input: {
    pollMs?: number;
    limit?: number;
    once?: boolean;
    json?: boolean;
    ensureWorkers?: boolean;
    telegram?: boolean;
    restartStale?: boolean;
    source?: string | null;
    emit?: (line: string) => void;
  } = {},
): Promise<Record<string, unknown>> {
  const emit =
    input.emit ?? ((line: string) => process.stdout.write(`${line}\n`));
  return await cliMeasure.measure(
    {
      start: () => "terminal feed follow",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      let ensureResult: Record<string, unknown> | null = null;
      if (input.ensureWorkers !== false) {
        ensureResult = await ensureWorkerGroup({
          telegram: input.telegram === true,
          source: input.source,
          restartStale: input.restartStale !== false,
        });
      }
      const pollMs = Math.max(
        250,
        input.pollMs ?? Number(process.env.SOLARD_TERMINAL_POLL_MS ?? "1000"),
      );
      let lastSeen = 0;
      let printed = 0;
      const status = Array.isArray(ensureResult?.status)
        ? (ensureResult.status as any[])
        : undefined;
      emit(
        `🦉 terminal feed listening source=${input.source ?? process.env.SOLARD_STREAM_SOURCE ?? "helius"} store=sqlite ${formatProcessSummary(status)} poll=${pollMs}ms`,
      );
      while (true) {
        const now = Date.now();
        const rows = listTerminalFeed({
          limit: input.limit ?? 250,
          sinceMs: lastSeen,
          includeUnpriced: String(
            input.source ?? process.env.SOLARD_STREAM_SOURCE ?? "helius",
          ).includes("helius"),
          source: input.source ?? process.env.SOLARD_STREAM_SOURCE ?? "helius",
        });
        for (const row of [...rows].reverse()) {
          const mark = Math.max(
            Number(row.updatedAtMs || 0),
            Number(row.createdAtMs || 0),
          );
          if (mark <= lastSeen) continue;
          lastSeen = Math.max(lastSeen, mark);
          printed++;
          emit(
            input.json ? JSON.stringify(row) : formatTerminalFeedRow(row, now),
          );
        }
        if (input.once) break;
        await sleep(pollMs);
      }
      return {
        printed,
        lastSeen,
        source: input.source ?? null,
        stats: terminalStoreStats(),
      };
    },
  );
}
