import type { PumpPriceAggregateRow } from "../../db/schema.js";
import type { SolardActionContext } from "./context.js";
import { measureSolard, summarizeForMeasure } from "../api-response.js";

export type ListSmaInput = {
  mint?: string | null;
  intervalSeconds?: number | null;
  limit?: number | null;
};

function clampLimit(value: number | null | undefined): number {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(1000, Math.trunc(parsed)));
}

export async function listSmaAggregatesAction(
  ctx: SolardActionContext,
  input: ListSmaInput = {},
): Promise<PumpPriceAggregateRow[]> {
  const mint = input.mint?.trim() || null;
  const intervalSeconds =
    input.intervalSeconds == null ? null : Number(input.intervalSeconds);
  const limit = clampLimit(input.limit);
  const measured = await measureSolard(
    `solard:action:market:sma${mint ? `:${mint.slice(0, 8)}` : ""}`,
    "listSmaAggregatesAction",
    () => {
      let query = ctx.sowl.db.pumpPriceAggregates.select();
      if (mint && intervalSeconds != null)
        query = query.where({ mint, intervalSeconds });
      else if (mint) query = query.where({ mint });
      else if (intervalSeconds != null)
        query = query.where({ intervalSeconds });
      return query
        .orderBy("bucketStartMs", "desc")
        .limit(limit)
        .all() as PumpPriceAggregateRow[];
    },
    {
      summarize: (value) => ({
        count: value.length,
        first: value[0] ? summarizeForMeasure(value[0]) : null,
      }),
      meta: { mint, intervalSeconds, limit },
      onError: (error) => {
        throw error;
      },
    },
  );
  return measured.value;
}
