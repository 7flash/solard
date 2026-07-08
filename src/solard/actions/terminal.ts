import {
  getPumpFeedDbStats,
  listObservedPumpHolders,
  listPumpTerminalFeedRows,
  type PumpTerminalFeedRow,
} from "../feed/feed-repo.js";
import { measureSolard, summarizeForMeasure } from "../api-response.js";

export type TerminalFeedInput = {
  sinceMs?: number | string | null;
  pinnedMints?: string[] | string | null;
  limit?: number | string | null;
};

export type TerminalHolderInput = {
  mint: string;
  limit?: number | string | null;
};

function numberInput(
  value: number | string | null | undefined,
  fallback: number,
): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listInput(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value))
    return value.map((item) => item.trim()).filter(Boolean);
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function feedSummary(rows: PumpTerminalFeedRow[]) {
  return {
    count: rows.length,
    newestUpdatedAtMs: rows[0]?.updatedAtMs ?? null,
    sample: rows.slice(0, 2).map((row) => ({
      mint: row.mint,
      symbol: row.symbol,
      marketCapSol: row.marketCapSol ?? row.lastMarketCapSol ?? null,
      sma1m: row.sma1m,
      sma5m: row.sma5m,
      sma15m: row.sma15m,
      updatedAtMs: row.updatedAtMs,
    })),
  };
}

export async function listTerminalFeedAction(input: TerminalFeedInput = {}) {
  const limit = Math.max(
    1,
    Math.min(500, Math.trunc(numberInput(input.limit, 250))),
  );
  const sinceMs = numberInput(input.sinceMs, 0);
  const pinnedMints = listInput(input.pinnedMints);
  const measured = await measureSolard(
    "solard:action:terminal:feed",
    "listTerminalFeedAction",
    () => listPumpTerminalFeedRows({ sinceMs, pinnedMints, limit }),
    {
      result: feedSummary,
      onError: summarizeForMeasure,
      meta: { sinceMs, pinnedCount: pinnedMints.length, limit },
    },
  );
  return measured.value;
}

export async function getTerminalFeedStatsAction() {
  const measured = await measureSolard(
    "solard:action:terminal:stats",
    "getTerminalFeedStatsAction",
    () => getPumpFeedDbStats(),
    {
      result: summarizeForMeasure,
      onError: summarizeForMeasure,
    },
  );
  return measured.value;
}

export async function listTerminalHoldersAction(input: TerminalHolderInput) {
  const mint = input.mint?.trim();
  if (!mint) throw new Error("mint is required");
  const limit = Math.max(
    1,
    Math.min(50, Math.trunc(numberInput(input.limit, 12))),
  );
  const measured = await measureSolard(
    `solard:action:terminal:holders:${mint.slice(0, 8)}`,
    "listTerminalHoldersAction",
    () => listObservedPumpHolders(mint, limit),
    {
      result: (rows) => ({
        count: rows.length,
        mint,
        sample: rows.slice(0, 2),
      }),
      onError: summarizeForMeasure,
      meta: { mint, limit },
    },
  );
  return measured.value;
}
