import { ensureBgrunWorker } from "../processes/bgrun.js";
import {
  listTerminalTrades,
  type TerminalTrade,
} from "../db/terminal-store.js";
import { cliMeasure, summarizeForMeasure } from "../measure.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: Math.abs(Number(value)) >= 1000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(Number(value)) >= 1000 ? 1 : 2,
  }).format(Number(value));
}

function short(value: string | null | undefined, left = 6, right = 4): string {
  if (!value) return "—";
  return value.length <= left + right + 1
    ? value
    : `${value.slice(0, left)}…${value.slice(-right)}`;
}

function renderTrade(row: TerminalTrade): string {
  const side = row.side.padEnd(4, " ");
  return `${side}\t${short(row.mint, 6, 6)}\t${row.solDeltaUi.toFixed(4)} SOL\tmcap=${compactUsd(row.marketCapUsd)}\tprice=${compactUsd(row.priceUsd)}\towner=${short(row.owner)}\tsig=${short(row.signature, 8, 6)}\t${row.confidence}`;
}

export async function followTradesAction(
  input: {
    pollMs?: number;
    limit?: number;
    once?: boolean;
    json?: boolean;
    mint?: string | null;
    ensureWorker?: boolean;
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
      if (input.ensureWorker !== false)
        await ensureBgrunWorker("solard-pump-trades");
      const pollMs = Math.max(
        250,
        input.pollMs ??
          Number(process.env.SOLARD_TRADE_STREAM_POLL_MS ?? "1000"),
      );
      let lastSeen = 0;
      let printed = 0;
      emit(
        `🦉 trade stream watching source=sqlite worker=solard-pump-trades poll=${pollMs}ms`,
      );
      while (true) {
        const rows = listTerminalTrades({
          limit: input.limit ?? 250,
          sinceMs: lastSeen,
          mint: input.mint ?? null,
        });
        for (const row of [...rows].reverse()) {
          const mark = Number(row.createdAtMs || row.updatedAtMs || 0);
          if (mark <= lastSeen) continue;
          lastSeen = Math.max(lastSeen, mark);
          printed++;
          emit(input.json ? JSON.stringify(row) : renderTrade(row));
        }
        if (input.once) break;
        await sleep(pollMs);
      }
      return { printed, lastSeen };
    },
  );
}
