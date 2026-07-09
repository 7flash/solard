import { setTimeout as delay } from "node:timers/promises";
import {
  getPumpFeedDbStats,
  listObservedPumpHolders,
  listPumpTerminalFeedRows,
  type PumpTerminalFeedRow,
} from "../feed/feed-repo.js";
import { measureSolard, summarizeForMeasure } from "../api-response.js";
import { handlePumpLivePost } from "../../pump/services/pump-live-api.js";

export type TerminalFeedInput = {
  sinceMs?: number | string | null;
  pinnedMints?: string[] | string | null;
  limit?: number | string | null;
};

export type TerminalHolderInput = {
  mint: string;
  limit?: number | string | null;
};

export type TerminalFeedFollowInput = TerminalFeedInput & {
  source?: "helius" | "pumpportal" | string | null;
  resetSession?: boolean | string | null;
  pollMs?: number | string | null;
  signal?: AbortSignal | null;
  onRows?: (rows: PumpTerminalFeedRow[]) => void | Promise<void>;
  onStatus?: (status: unknown) => void | Promise<void>;
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

function boolInput(
  value: boolean | string | null | undefined,
  fallback: boolean,
): boolean {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return (
    value !== "0" &&
    value.toLowerCase() !== "false" &&
    value.toLowerCase() !== "no"
  );
}

function rowKey(row: PumpTerminalFeedRow): string {
  return [row.mint ?? "", row.signature ?? "", row.updatedAtMs ?? ""].join(":");
}

async function startTerminalWorker(
  input: TerminalFeedFollowInput,
): Promise<unknown> {
  const source = input.source === "pumpportal" ? "pumpportal" : "helius";
  const resetSession = boolInput(input.resetSession, true);
  return await measureSolard(
    "solard:action:terminal:feed",
    "startTerminalFeedWorker",
    async () => {
      const headers = new Headers({ "content-type": "application/json" });
      const token = process.env.SOLWAL_WEB_TOKEN?.trim();
      if (token) headers.set("x-solwal-web-token", token);
      const response = await handlePumpLivePost(
        new Request("http://solard.local/api/pump-live", {
          method: "POST",
          headers,
          body: JSON.stringify({
            action: "start-worker",
            source,
            resetSession,
          }),
        }),
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(
          payload?.error ?? `start-worker failed: HTTP ${response.status}`,
        );
      }
      return payload?.value ?? payload;
    },
    {
      result: summarizeForMeasure,
      onError: summarizeForMeasure,
      meta: { source, resetSession },
    },
  ).then((measured) => measured.value);
}

export async function followTerminalFeedAction(
  input: TerminalFeedFollowInput = {},
): Promise<void> {
  const limit = Math.max(
    1,
    Math.min(500, Math.trunc(numberInput(input.limit, 250))),
  );
  const pollMs = Math.max(
    250,
    Math.min(30_000, Math.trunc(numberInput(input.pollMs, 1_500))),
  );
  const pinnedMints = listInput(input.pinnedMints);
  const startedAtMs = numberInput(input.sinceMs, Date.now());
  const seen = new Set<string>();
  let sinceMs = startedAtMs;

  const status = await startTerminalWorker(input);
  await input.onStatus?.(status);

  while (!input.signal?.aborted) {
    try {
      const rows = listPumpTerminalFeedRows({ sinceMs, pinnedMints, limit });
      const fresh = rows
        .filter((row) => {
          const updatedAtMs = Number(row.updatedAtMs ?? row.createdAtMs ?? 0);
          if (!Number.isFinite(updatedAtMs) || updatedAtMs < sinceMs - 15_000)
            return false;
          const key = rowKey(row);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort(
          (a, b) => Number(a.updatedAtMs ?? 0) - Number(b.updatedAtMs ?? 0),
        );
      if (fresh.length) {
        const newest = Math.max(
          ...fresh.map((row) =>
            Number(row.updatedAtMs ?? row.createdAtMs ?? sinceMs),
          ),
        );
        if (Number.isFinite(newest)) sinceMs = Math.max(sinceMs, newest);
        await input.onRows?.(fresh);
      }
    } catch (error) {
      await measureSolard(
        "solard:action:terminal:feed",
        "followTerminalFeedPollError",
        () => {
          throw error;
        },
        {
          result: summarizeForMeasure,
          onError: summarizeForMeasure,
          meta: { sinceMs, pinnedCount: pinnedMints.length, limit },
        },
      ).catch(() => undefined);
      await input.onStatus?.({
        status: "poll-error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await delay(pollMs, undefined, { signal: input.signal ?? undefined });
    } catch {
      break;
    }
  }
}
