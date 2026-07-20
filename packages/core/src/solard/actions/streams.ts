import { ensureBgrunWorker } from "../processes/bgrun.ts";
import { listTerminalTrades } from "@solard/core/db.js";
import { cliMeasure, summarizeForMeasure } from "../measure.ts";
import { formatTerminalTradeRow } from "../terminal/presenter.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamWorkerForSource(
  source?: string | null,
): "solard-helius-logs-v1" | "solard-pumpportal-live-v2" {
  return String(source ?? process.env.SOLARD_STREAM_SOURCE ?? "helius")
    .toLowerCase()
    .includes("pump")
    ? "solard-pumpportal-live-v2"
    : "solard-helius-logs-v1";
}

export async function followTradesAction(
  input: {
    pollMs?: number;
    limit?: number;
    once?: boolean;
    json?: boolean;
    mint?: string | null;
    ensureWorker?: boolean;
    restart?: boolean;
    source?: string | null;
    emit?: (line: string) => void;
  } = {},
): Promise<Record<string, unknown>> {
  const emit =
    input.emit ?? ((line: string) => process.stdout.write(`${line}\n`));
  return await cliMeasure.measure(
    {
      start: () => "stream trades follow",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      const worker = streamWorkerForSource(input.source);
      if (input.ensureWorker !== false)
        await ensureBgrunWorker(worker, input.restart === true);
      const pollMs = Math.max(
        250,
        input.pollMs ??
          Number(process.env.SOLARD_TRADE_STREAM_POLL_MS ?? "1000"),
      );
      let lastSeen = 0;
      let printed = 0;
      emit(
        `🦉 trade stream watching source=${input.source ?? process.env.SOLARD_STREAM_SOURCE ?? "helius"} store=sqlite worker=${worker} poll=${pollMs}ms`,
      );
      while (true) {
        const rows = listTerminalTrades({
          limit: input.limit ?? 250,
          sinceMs: lastSeen,
          mint: input.mint ?? null,
          source: input.source ?? process.env.SOLARD_STREAM_SOURCE ?? "helius",
        });
        for (const row of [...rows].reverse()) {
          const mark = Number(row.createdAtMs || row.updatedAtMs || 0);
          if (mark <= lastSeen) continue;
          lastSeen = Math.max(lastSeen, mark);
          printed++;
          emit(input.json ? JSON.stringify(row) : formatTerminalTradeRow(row));
        }
        if (input.once) break;
        await sleep(pollMs);
      }
      return { printed, lastSeen, source: input.source ?? null, worker };
    },
  );
}
