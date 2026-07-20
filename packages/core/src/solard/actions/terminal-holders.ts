import {
  getCachedTokenHolders,
  getOrRefreshTokenHolders,
  refreshRecentHolderSnapshots,
  refreshTokenHolders,
} from "../db/terminal-holders.ts";
import { createMeasure, summarizeForMeasure } from "../measure.ts";

const holderActionMeasure = createMeasure("solard:holders");

export async function getTerminalHoldersAction(input: {
  mint: string;
  limit?: number;
  refresh?: boolean;
  source?: string;
}) {
  return await holderActionMeasure.measure(
    {
      start: () => "get terminal holders",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => await getOrRefreshTokenHolders(input.mint, input),
  );
}

export async function refreshTerminalHoldersAction(input: {
  mint: string;
  limit?: number;
  source?: string;
}) {
  return await holderActionMeasure.measure(
    {
      start: () => "refresh terminal holders",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => await refreshTokenHolders(input.mint, input),
  );
}

export async function refreshTerminalHolderCandidatesAction(
  input: {
    limit?: number;
    source?: string | null;
  } = {},
) {
  return await holderActionMeasure.measure(
    {
      start: () => "refresh recent holder candidates",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => await refreshRecentHolderSnapshots(input),
  );
}

export function getCachedTerminalHoldersAction(input: {
  mint: string;
  limit?: number;
}) {
  return getCachedTokenHolders(input.mint, input.limit ?? 20);
}
