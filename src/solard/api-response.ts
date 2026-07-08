import { createMeasure } from "measure-fn";

export type SolardApiMeta = {
  route?: string;
  method?: string;
  scope?: string;
  requestId?: string;
  tookMs?: number;
  summary?: unknown;
  warnings?: string[];
};

export type SolardApiOk<T> = {
  ok: true;
  value: T;
  meta?: SolardApiMeta;
};

export type SolardApiError = {
  ok: false;
  error: string;
  meta?: SolardApiMeta;
};

export type SolardApiEnvelope<T> = SolardApiOk<T> | SolardApiError;

const SENSITIVE_KEY =
  /secret|private|mnemonic|seed|keypair|password|authorization|cookie|token/i;
const BIG_ARRAY_SAMPLE = 2;
const BIG_OBJECT_KEYS = 32;

export function solardOk<T>(value: T, meta?: SolardApiMeta): SolardApiOk<T> {
  return { ok: true, value, ...(meta ? { meta } : {}) };
}

export function solardError(
  error: unknown,
  meta?: SolardApiMeta,
): SolardApiError {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(meta ? { meta } : {}),
  };
}

export function summarizeForMeasure(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length <= 160) return value;
    return `${value.slice(0, 80)}…${value.slice(-24)} (${value.length} chars)`;
  }
  if (value instanceof Error)
    return { name: value.name, message: value.message };
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
      if (Array.isArray(item)) {
        out[key] = { type: "array", length: item.length };
      } else if (item && typeof item === "object") {
        out[key] =
          depth >= 2
            ? {
                type: "object",
                keys: Object.keys(item as Record<string, unknown>).length,
              }
            : summarizeForMeasure(item, depth + 1);
      } else {
        out[key] = summarizeForMeasure(item, depth + 1);
      }
    }
    if (keys.length > BIG_OBJECT_KEYS)
      out.omittedKeys = keys.length - BIG_OBJECT_KEYS;
    return out;
  }
  return String(value);
}

type RawMeasureScope = {
  measure?:
    | { assert?: <T>(label: string, fn: () => Promise<T>) => Promise<T> }
    | ((
        label: string,
        fn: () => Promise<unknown>,
      ) => Promise<unknown> | unknown);
  measureSync?:
    | { assert?: <T>(label: string, fn: () => T) => T }
    | ((label: string, fn: () => unknown) => unknown);
  resetCounter?: () => void;
};

function safeScope(name: string): RawMeasureScope | null {
  try {
    return createMeasure(name, {
      maxResultLength: Number(
        process.env.SOLARD_MEASURE_MAX_RESULT_LENGTH ?? "1600",
      ),
    }) as RawMeasureScope;
  } catch {
    return null;
  }
}

async function assertAsync<T>(
  scope: RawMeasureScope | null,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const measure = scope?.measure;
  if (
    measure &&
    typeof measure === "object" &&
    typeof measure.assert === "function"
  )
    return await measure.assert(label, fn);
  if (typeof measure === "function")
    return await (measure(label, fn) as Promise<T> | T);
  return await fn();
}

export async function measureSolard<T>(
  scopeName: string,
  label: string,
  operation: () => Promise<T> | T,
  summarize: (value: T) => unknown = summarizeForMeasure,
): Promise<{
  value: T;
  tookMs: number;
  summary: unknown;
  scope: string;
  label: string;
}> {
  const scope = safeScope(scopeName);
  const started = Date.now();
  let value!: T;
  let hasValue = false;
  const summary = await assertAsync(scope, label, async () => {
    value = await operation();
    hasValue = true;
    return summarize(value);
  });
  if (!hasValue)
    throw new Error(
      `Measured operation did not produce a value: ${scopeName}:${label}`,
    );
  return {
    value,
    tookMs: Date.now() - started,
    summary,
    scope: scopeName,
    label,
  };
}

export async function measured<T>(
  route: string,
  fn: () => Promise<T> | T,
): Promise<SolardApiOk<T>> {
  const measuredValue = await measureSolard<T>(
    `solard:api:${route}`,
    "handler",
    fn,
    summarizeForMeasure,
  );
  return solardOk(measuredValue.value, {
    route,
    scope: measuredValue.scope,
    tookMs: measuredValue.tookMs,
    summary: measuredValue.summary,
  });
}
