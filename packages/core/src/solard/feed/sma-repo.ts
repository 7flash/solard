import { openDatabase } from "../../db/database.ts";
import type { PumpPriceAggregateRow } from "../../db/schema.ts";

export type PumpSmaQuery = {
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

function db() {
  return openDatabase();
}

export function listPumpSmaAggregates(
  input: PumpSmaQuery = {},
): PumpPriceAggregateRow[] {
  const mint = input.mint?.trim() || null;
  const intervalSeconds =
    input.intervalSeconds == null ? null : Number(input.intervalSeconds);
  const limit = clampLimit(input.limit);
  const table = input.latestOnly ? "pumpLatestSma" : "pumpPriceAggregates";

  // sqlite-zod-orm owns tables and indexes; this raw fallback is read-only and lets
  // CLI/API use the latest-SMA view created during DB boot when the adapter exposes SQL.
  const database = db() as unknown as {
    all?: (sql: string, params?: unknown[]) => unknown[];
    query?: (
      sql: string,
      params?: unknown[],
    ) => { all?: () => unknown[] } | unknown[];
  };
  const where: string[] = [];
  const params: unknown[] = [];
  if (mint) {
    where.push("mint = ?");
    params.push(mint);
  }
  if (intervalSeconds != null && Number.isFinite(intervalSeconds)) {
    where.push("intervalSeconds = ?");
    params.push(intervalSeconds);
  }
  const sql = `select * from ${table}${where.length ? ` where ${where.join(" and ")}` : ""} order by bucketStartMs desc limit ?`;
  if (typeof database.all === "function") {
    try {
      return database.all(sql, [...params, limit]) as PumpPriceAggregateRow[];
    } catch {
      // Fall back to ORM table below.
    }
  }
  if (typeof database.query === "function") {
    try {
      const result = database.query(sql, [...params, limit]);
      if (Array.isArray(result)) return result as PumpPriceAggregateRow[];
      if (
        result &&
        typeof result === "object" &&
        typeof result.all === "function"
      ) {
        return result.all() as PumpPriceAggregateRow[];
      }
    } catch {
      // Fall back to ORM table below.
    }
  }

  let query = db().pumpPriceAggregates.select();
  if (mint && intervalSeconds != null)
    query = query.where({ mint, intervalSeconds });
  else if (mint) query = query.where({ mint });
  else if (intervalSeconds != null) query = query.where({ intervalSeconds });
  const rows = query
    .orderBy("bucketStartMs", "desc")
    .limit(limit * (input.latestOnly ? 8 : 1))
    .all() as PumpPriceAggregateRow[];
  if (!input.latestOnly) return rows.slice(0, limit);

  const seen = new Set<string>();
  const latest: PumpPriceAggregateRow[] = [];
  for (const row of rows) {
    const key = `${row.mint}:${row.intervalSeconds}`;
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(row);
    if (latest.length >= limit) break;
  }
  return latest;
}
