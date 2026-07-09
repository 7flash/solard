import { ensureWorkerGroup } from "../processes/bgrun.js";
import {
  listTerminalFeed,
  terminalStoreStats,
  type TerminalFeedRow,
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

function renderRow(row: TerminalFeedRow): string {
  const kind = row.kind === "signal" ? "[SIGNAL]" : "[PUMP]";
  const symbol = row.symbol ? `$${row.symbol}` : "$?";
  const mcap = compactUsd(row.marketCapUsd);
  const sma1 = compactUsd(row.sma1m);
  const sma5 = compactUsd(row.sma5m);
  const sma15 = compactUsd(row.sma15m);
  const ageSec = Math.max(
    0,
    Math.round(
      (Date.now() - Number(row.updatedAtMs || row.createdAtMs || Date.now())) /
        1000,
    ),
  );
  return `${kind}\t${symbol}\t${short(row.mint, 6, 6)}\tmcap=${mcap}\tsma1=${sma1}\tsma5=${sma5}\tsma15=${sma15}\ttrades=${row.tradeCount ?? 0}\tage=${ageSec}s`;
}

export async function terminalFeedSnapshotAction(
  input: { limit?: number; sinceMs?: number } = {},
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
      });
      return { rows, stats: terminalStoreStats() };
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
      if (input.ensureWorkers !== false) {
        await ensureWorkerGroup({ telegram: input.telegram === true });
      }
      const pollMs = Math.max(
        250,
        input.pollMs ?? Number(process.env.SOLARD_TERMINAL_POLL_MS ?? "1000"),
      );
      let lastSeen = 0;
      let printed = 0;
      emit(
        `🦉 terminal feed listening source=sqlite workers=background poll=${pollMs}ms`,
      );
      while (true) {
        const rows = listTerminalFeed({
          limit: input.limit ?? 250,
          sinceMs: lastSeen,
        });
        for (const row of [...rows].reverse()) {
          const mark = Math.max(
            Number(row.updatedAtMs || 0),
            Number(row.createdAtMs || 0),
          );
          if (mark <= lastSeen) continue;
          lastSeen = Math.max(lastSeen, mark);
          printed++;
          emit(input.json ? JSON.stringify(row) : renderRow(row));
        }
        if (input.once) break;
        await sleep(pollMs);
      }
      return { printed, lastSeen, stats: terminalStoreStats() };
    },
  );
}
