import { createMeasure } from "measure-fn";

export type SolardApiMeta = {
  route?: string;
  method?: string;
  scope?: string;
  label?: string;
  requestId?: string;
  tookMs?: number;
  summary?: unknown;
  warnings?: string[];
  [key: string]: unknown;
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
const DEFAULT_MAX_RESULT_LENGTH = 1600;

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
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack:
        process.env.SOLARD_MEASURE_STACK === "1" ||
        process.env.SOLWAL_WEB_DEBUG === "1"
          ? value.stack
          : undefined,
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

type SolardMeasureScope = ReturnType<typeof createMeasure>;

export type SolardMeasureOptions<T> = {
  result?: (value: T) => unknown;
  summarize?: (value: T) => unknown;
  onError?: (error: unknown) => unknown;
  start?: () => unknown;
  end?: (value: T) => unknown;
  meta?: Record<string, unknown>;
  maxResultLength?: number;
};

type MeasureAction<T = unknown> =
  | string
  | {
      label: string;
      start?: () => unknown;
      end?: (value: T) => unknown;
      result?: (value: T) => unknown;
      onError?: (error: unknown) => unknown;
      maxResultLength?: number;
      meta?: Record<string, unknown>;
      [key: string]: unknown;
    };

function maxResultLength(input?: number): number {
  const parsed = Number(
    input ??
      process.env.SOLARD_MEASURE_MAX_RESULT_LENGTH ??
      DEFAULT_MAX_RESULT_LENGTH,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_MAX_RESULT_LENGTH;
}

function quietMeasure(): boolean {
  return (
    process.env.SOLARD_MEASURE_QUIET === "1" ||
    process.env.SOLWAL_MEASURE_QUIET === "1" ||
    process.env.SOLARD_MEASURE === "0" ||
    process.env.SOLWAL_MEASURE === "0"
  );
}

function safeScope(
  name: string,
  maxLength?: number,
): SolardMeasureScope | null {
  if (quietMeasure()) return null;
  try {
    return createMeasure(name, {
      maxResultLength: maxResultLength(maxLength),
    }) as SolardMeasureScope;
  } catch {
    return null;
  }
}

function measureAction<T>(
  label: string,
  options: SolardMeasureOptions<T>,
): MeasureAction<T> {
  const result = options.result ?? options.summarize ?? summarizeForMeasure;
  return {
    label,
    start: options.start ?? (() => ({ label, ...(options.meta ?? {}) })),
    end: options.end ?? result,
    result,
    onError: options.onError ?? summarizeForMeasure,
    maxResultLength: maxResultLength(options.maxResultLength),
    ...(options.meta ? { meta: summarizeForMeasure(options.meta) } : {}),
  };
}

function normalizeMeasureOptions<T>(
  input?: ((value: T) => unknown) | SolardMeasureOptions<T>,
): SolardMeasureOptions<T> {
  if (typeof input === "function") return { result: input };
  return input ?? { result: summarizeForMeasure };
}

export async function measureSolard<T>(
  scopeName: string,
  label: string,
  operation: () => Promise<T> | T,
  optionsOrSummarize?: ((value: T) => unknown) | SolardMeasureOptions<T>,
): Promise<{
  value: T;
  tookMs: number;
  summary: unknown;
  scope: string;
  label: string;
}> {
  const options = normalizeMeasureOptions(optionsOrSummarize);
  const result = options.result ?? options.summarize ?? summarizeForMeasure;
  const scope = safeScope(scopeName, options.maxResultLength);
  const started = Date.now();
  try {
    const value = scope
      ? ((await scope.measure(
          measureAction(label, options),
          async () => await operation(),
        )) as T)
      : await operation();
    return {
      value,
      tookMs: Date.now() - started,
      summary: result(value),
      scope: scopeName,
      label,
    };
  } catch (error) {
    if (options.onError) options.onError(error);
    throw error;
  }
}

export async function measured<T>(
  route: string,
  fn: () => Promise<T> | T,
): Promise<SolardApiOk<T>> {
  const measuredValue = await measureSolard<T>(
    `solard:api:${route}`,
    "handler",
    fn,
    {
      result: summarizeForMeasure,
      onError: summarizeForMeasure,
      meta: { route },
    },
  );
  return solardOk(measuredValue.value, {
    route,
    scope: measuredValue.scope,
    label: measuredValue.label,
    tookMs: measuredValue.tookMs,
    summary: measuredValue.summary,
  });
}
