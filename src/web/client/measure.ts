import { createMeasure } from "measure-fn";

const SENSITIVE_KEY =
  /secret|private|mnemonic|seed|keypair|password|authorization|cookie|token/i;

type RawMeasureScope = {
  measure?:
    | { assert?: <T>(label: string, fn: () => Promise<T>) => Promise<T> }
    | ((
        label: string,
        fn: () => Promise<unknown>,
      ) => Promise<unknown> | unknown);
  measureSync?:
    | { assert?: <T>(label: string, fn: () => T) => T }
    | ((label: string, fn?: () => unknown) => unknown);
};

export function summarizeForClient(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string")
    return value.length > 140
      ? `${value.slice(0, 70)}…${value.slice(-20)} (${value.length} chars)`
      : value;
  if (value instanceof Error)
    return { name: value.name, message: value.message };
  if (Array.isArray(value))
    return depth >= 2
      ? { type: "array", length: value.length }
      : {
          type: "array",
          length: value.length,
          sample: value
            .slice(0, 2)
            .map((item) => summarizeForClient(item, depth + 1)),
        };
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const keys = Object.keys(input);
    const out: Record<string, unknown> = { type: "object", keys: keys.length };
    for (const key of keys.slice(0, 24)) {
      if (SENSITIVE_KEY.test(key)) out[key] = "[omitted]";
      else if (Array.isArray(input[key]))
        out[key] = { type: "array", length: (input[key] as unknown[]).length };
      else
        out[key] =
          depth >= 2 && input[key] && typeof input[key] === "object"
            ? {
                type: "object",
                keys: Object.keys(input[key] as Record<string, unknown>).length,
              }
            : summarizeForClient(input[key], depth + 1);
    }
    if (keys.length > 24) out.omittedKeys = keys.length - 24;
    return out;
  }
  return String(value);
}

function safeMeasure(scope: string): RawMeasureScope | null {
  try {
    return createMeasure(scope, { maxResultLength: 1200 }) as RawMeasureScope;
  } catch {
    return null;
  }
}

async function runMeasured<T>(
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

function runMeasuredSync<T>(
  scope: RawMeasureScope | null,
  label: string,
  fn: () => T,
): T {
  const measureSync = scope?.measureSync;
  if (
    measureSync &&
    typeof measureSync === "object" &&
    typeof measureSync.assert === "function"
  )
    return measureSync.assert(label, fn);
  if (typeof measureSync === "function") return measureSync(label, fn) as T;
  return fn();
}

export function createClientMeasureScope(scopeName: string) {
  const scope = safeMeasure(scopeName);
  return {
    event(label: string, summary?: unknown) {
      runMeasuredSync(scope, label, () => summarizeForClient(summary));
    },
    async measure<T>(
      label: string,
      operation: () => Promise<T> | T,
      summarize: (value: T) => unknown = summarizeForClient,
    ): Promise<T> {
      let value!: T;
      let hasValue = false;
      await runMeasured(scope, label, async () => {
        value = await operation();
        hasValue = true;
        return summarize(value);
      });
      if (!hasValue)
        throw new Error(`Measured operation produced no value: ${label}`);
      return value;
    },
    measureSync<T>(
      label: string,
      operation: () => T,
      summarize: (value: T) => unknown = summarizeForClient,
    ): T {
      let value!: T;
      let hasValue = false;
      runMeasuredSync(scope, label, () => {
        value = operation();
        hasValue = true;
        return summarize(value);
      });
      if (!hasValue)
        throw new Error(`Measured operation produced no value: ${label}`);
      return value;
    },
  };
}
