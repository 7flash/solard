import type { SowlDatabase, PriceSampleRow } from "./schema.js";
import { measure } from "../core/log.js";
import { priceSampleLog } from "../core/log-result.js";
import { measuredSync } from "../core/measured.js";

const m = measure("prices");

export type PriceWindow = {
  mint: string;
  sinceMs: number;
  untilMs: number;
  samples: number;
  averagePriceQuotePerToken: number | null;
  minimumPriceQuotePerToken: number | null;
  maximumPriceQuotePerToken: number | null;
  lastPriceQuotePerToken: number | null;
};

export class PriceRepo {
  constructor(private readonly db: SowlDatabase) {}

  record(input: Omit<PriceSampleRow, "id">): PriceSampleRow {
    return measuredSync(m, `record ${input.mint.slice(0, 8)} ${input.venue}`, () =>
      this.db.priceSamples.insert(input) as PriceSampleRow,
      priceSampleLog,
    );
  }

  latest(mint: string): PriceSampleRow | undefined {
    return this.db.priceSamples
      .select()
      .where({ mint })
      .orderBy("capturedAtMs", "desc")
      .limit(1)
      .first() as PriceSampleRow | undefined;
  }

  history(mint: string, args: { sinceMs?: number; limit?: number } = {}): PriceSampleRow[] {
    const rows = this.db.priceSamples
      .select()
      .where({ mint })
      .orderBy("capturedAtMs", "desc")
      .limit(args.limit ?? 10_000)
      .all() as PriceSampleRow[];
    return args.sinceMs == null ? rows : rows.filter((row) => row.capturedAtMs >= args.sinceMs!);
  }

  average(mint: string, periodMs: number, nowMs = Date.now()): PriceWindow {
    const sinceMs = nowMs - periodMs;
    const rows = this.history(mint, { sinceMs });
    const values = rows.map((row) => row.priceQuotePerToken).filter((value) => Number.isFinite(value) && value > 0);
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    return {
      mint,
      sinceMs,
      untilMs: nowMs,
      samples: values.length,
      averagePriceQuotePerToken: average,
      minimumPriceQuotePerToken: values.length ? Math.min(...values) : null,
      maximumPriceQuotePerToken: values.length ? Math.max(...values) : null,
      lastPriceQuotePerToken: rows[0]?.priceQuotePerToken ?? null,
    };
  }
}
