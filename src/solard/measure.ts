import {
  configure,
  createMeasure,
  measure,
  measureSync,
  safeStringify,
  summarizeForMeasure,
} from "measure-fn";

let configured = false;

function readIntEnv(name: string, fallback: number, max = 10_000): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;

  return Math.min(Math.floor(value), max);
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

    maxResultLength: readIntEnv("SOLARD_MEASURE_MAX_RESULT_LENGTH", 900),

    summarize: true,
    stripScopePrefix: true,

    sensitiveKeyPattern:
      /secret|private|mnemonic|seed|keypair|password|authorization|cookie|token|apikey|api_key|rpc_endpoint|rpc_url|sender_url|endpoint|url/i,

    maxSummaryDepth: readIntEnv("SOLARD_MEASURE_MAX_SUMMARY_DEPTH", 4, 20),
    maxSummaryStringLength: readIntEnv(
      "SOLARD_MEASURE_MAX_SUMMARY_STRING_LENGTH",
      160,
      2_000,
    ),
    summaryArraySample: readIntEnv("SOLARD_MEASURE_ARRAY_SAMPLE", 2, 20),
    summaryObjectKeys: readIntEnv("SOLARD_MEASURE_OBJECT_KEYS", 24, 200),
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
  label: string,
  opts: { attempts: number; delay: number; backoff: number },
  fn: () => Promise<T>,
): Promise<T> {
  return await measure.retry(label, opts, fn);
}
