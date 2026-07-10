import {
  configure,
  createMeasure,
  measure,
  measureSync,
  safeStringify,
  summarizeForMeasure,
  type MeasureAction,
} from "measure-fn";

let configured = false;

function readIntEnv(name: string, fallback: number, max = 10_000): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;

  return Math.min(Math.floor(value), max);
}

function n(value: unknown, digits = 4): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Number(value.toFixed(digits));
}

function compactId(value: unknown, head = 6, tail = 4): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function clean<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }

  return value;
}

function compactDbResult(label: string, result: unknown): unknown {
  if (result == null) return result;

  if (Array.isArray(result)) {
    if (label.includes("helius_logs_indicators")) {
      return clean({
        rows: result.length,
        intervals: result.map((row: any) => row?.intervalSec).filter(Boolean),
        trades: result[0]?.tradeCount,
        vol: n(result[0]?.volumeSol, 4),
      });
    }

    return { rows: result.length };
  }

  if (typeof result !== "object") return result;

  const row = result as Record<string, any>;

  if (label.includes("helius_logs_trade_metadata")) {
    return clean({
      mint: compactId(row.mint),
      symbol: row.symbol,
      image: !!row.image,
      mcap: n(row.marketCapUsd, 2),
    });
  }

  if (label.includes("helius_logs_trade_token")) {
    return clean({
      mint: compactId(row.mint),
      symbol: row.symbol,
      image: !!row.image,
      mcap: n(row.marketCapUsd, 2),
    });
  }

  if (label.includes("helius_logs_trade")) {
    return clean({
      mint: compactId(row.mint),
      side: row.side,
      sol: n(row.solDeltaUi, 4),
      mcap: n(row.marketCapUsd, 2),
    });
  }

  if (label.includes("helius_logs_create")) {
    return clean({
      mint: compactId(row.mint),
      symbol: row.symbol,
      name: row.name,
      image: !!row.image,
    });
  }

  if (label.includes("helius_logs_complete")) {
    return clean({
      mint: compactId(row.mint),
      phase: row.phase,
      slot: row.lastSlot ?? row.slot,
    });
  }

  return summarizeForMeasure(result);
}

export function dbMeasureAction<T>(label: string): MeasureAction<T> {
  const fullLabel = label.startsWith("db.") ? label : `db.${label}`;

  return {
    start: () => fullLabel,
    end: (result: T) => compactDbResult(fullLabel, result),
  };
}

export function configureSolardMeasure(): void {
  if (configured) return;
  configured = true;

  configure({
    timestamps:
      process.env.SOLARD_MEASURE_TIMESTAMPS !== "0" &&
      process.env.SOLWAL_MEASURE_TIMESTAMPS !== "0",

    silent:
      process.env.SOLARD_MEASURE === "0" ||
      process.env.SOLARD_MEASURE_SILENT === "1",

    maxResultLength: readIntEnv("SOLARD_MEASURE_MAX_RESULT_LENGTH", 500),

    summarize: true,
    stripScopePrefix: true,

    sensitiveKeyPattern:
      /secret|private|mnemonic|seed|keypair|password|authorization|cookie|token|apikey|api_key|rpc_endpoint|rpc_url|sender_url|endpoint|url/i,

    maxSummaryDepth: readIntEnv("SOLARD_MEASURE_MAX_SUMMARY_DEPTH", 3, 20),
    maxSummaryStringLength: readIntEnv(
      "SOLARD_MEASURE_MAX_SUMMARY_STRING_LENGTH",
      96,
      2_000,
    ),
    summaryArraySample: readIntEnv("SOLARD_MEASURE_ARRAY_SAMPLE", 1, 20),
    summaryObjectKeys: readIntEnv("SOLARD_MEASURE_OBJECT_KEYS", 12, 200),
  });
}

configureSolardMeasure();

export { measure, measureSync, safeStringify, summarizeForMeasure };

export const apiMeasure = createMeasure("solard:api");
export const cliMeasure = createMeasure("solard:cli");
export const dbMeasure = createMeasure("solard:db");
export const workerMeasure = createMeasure("solard:worker");
export const processMeasure = createMeasure("solard:process");

export async function measureRetry<T>(
  label: string | MeasureAction<T>,
  opts: { attempts: number; delay: number; backoff: number },
  fn: () => Promise<T>,
): Promise<T> {
  return await measure.retry(label as MeasureAction<T>, opts, fn);
}
