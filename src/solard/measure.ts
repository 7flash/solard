import {
  configure,
  createMeasure,
  measure,
  measureSync,
  safeStringify,
} from "measure-fn";

let configured = false;

export function configureSolardMeasure(): void {
  if (configured) return;
  configured = true;
  configure({
    timestamps:
      process.env.SOLARD_MEASURE_TIMESTAMPS !== "0" &&
      process.env.SOLWAL_MEASURE_TIMESTAMPS !== "0",
    maxResultLength: Number(
      process.env.SOLARD_MEASURE_MAX_RESULT_LENGTH ?? "900",
    ),
  });
}

configureSolardMeasure();

export { measure, measureSync, createMeasure, safeStringify };

export const apiMeasure = createMeasure("solard:api");
export const cliMeasure = createMeasure("solard:cli");
export const dbMeasure = createMeasure("solard:db");
export const workerMeasure = createMeasure("solard:worker");
export const processMeasure = createMeasure("solard:process");

const SENSITIVE_KEY =
  /secret|private|mnemonic|seed|keypair|password|authorization|cookie|token|apikey|api_key/i;
const BIG_ARRAY_SAMPLE = 2;
const BIG_OBJECT_KEYS = 24;

export function summarizeForMeasure(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length <= 160) return value;
    return `${value.slice(0, 80)}…${value.slice(-24)} (${value.length} chars)`;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      cause:
        value.cause == null
          ? undefined
          : summarizeForMeasure(value.cause, depth + 1),
    };
  }
  if (Array.isArray(value)) {
    if (depth >= 2) return { type: "array", length: value.length };
    return {
      type: "array",
      length: value.length,
      sample: value
        .slice(0, BIG_ARRAY_SAMPLE)
        .map((item) => summarizeForMeasure(item, depth + 1)),
    };
  }
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const keys = Object.keys(input);
    const out: Record<string, unknown> = { type: "object", keys: keys.length };
    for (const key of keys.slice(0, BIG_OBJECT_KEYS)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = "[omitted]";
        continue;
      }
      const item = input[key];
      if (Array.isArray(item) && item.length > 8) {
        out[key] = { type: "array", length: item.length };
        continue;
      }
      out[key] = summarizeForMeasure(item, depth + 1);
    }
    if (keys.length > BIG_OBJECT_KEYS)
      out.omittedKeys = keys.length - BIG_OBJECT_KEYS;
    return out;
  }
  return String(value);
}

export function summarizeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      cause: error.cause == null ? undefined : summarizeForMeasure(error.cause),
    };
  }
  return summarizeForMeasure(error);
}

export async function measureRetry<T>(
  label: string,
  opts: { attempts: number; delay: number; backoff: number },
  fn: () => Promise<T>,
): Promise<T> {
  return await measure.retry(
    {
      start: () => label,
      end: (result: T) => ({ result: summarizeForMeasure(result) }),
    },
    opts,
    fn,
  );
}
