import type { PumpPriceAggregateRow } from "../../db/schema.ts";
import type { SolardActionContext } from "./context.ts";
import { listPumpSmaAggregates } from "../feed/sma-repo.ts";
import { measureSolard, summarizeForMeasure } from "../api-response.ts";

export type ListSmaInput = {
  mint?: string | null;
  intervalSeconds?: number | null;
  limit?: number | null;
  latestOnly?: boolean | null;
};

function clampLimit(value: number | null | undefined): number {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(1000, Math.trunc(parsed)));
}

export async function listSmaAggregatesAction(
  _ctx: SolardActionContext,
  input: ListSmaInput = {},
): Promise<PumpPriceAggregateRow[]> {
  const mint = input.mint?.trim() || null;
  const intervalSeconds =
    input.intervalSeconds == null ? null : Number(input.intervalSeconds);
  const limit = clampLimit(input.limit);
  const latestOnly = Boolean(input.latestOnly);
  const measured = await measureSolard(
    `solard:action:market:sma${mint ? `:${mint.slice(0, 8)}` : ""}`,
    "listSmaAggregatesAction",
    () =>
      listPumpSmaAggregates({
        mint,
        intervalSeconds,
        limit,
        latestOnly,
      }),
    {
      result: (value) => ({
        count: value.length,
        latestOnly,
        first: value[0] ? summarizeForMeasure(value[0]) : null,
      }),
      onError: summarizeForMeasure,
      meta: { mint, intervalSeconds, limit, latestOnly },
    },
  );
  return measured.value;
}
