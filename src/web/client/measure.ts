import { createMeasure } from "measure-fn";

const SENSITIVE_KEY =
  /secret|private|mnemonic|seed|keypair|password|authorization|cookie|token/i;

type MeasureAction<T = unknown> =
  | string
  | {
      label: string;
      start?: () => unknown;
      end?: (value: T) => unknown;
      result?: (value: T) => unknown;
      maxResultLength?: number;
      budget?: number;
      timeout?: number;
      meta?: Record<string, unknown>;
      [key: string]: unknown;
    };

type ScopedMeasure = ReturnType<typeof createMeasure>;

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
  if (Array.isArray(value)) {
    return depth >= 2
      ? { type: "array", length: value.length }
      : {
          type: "array",
          length: value.length,
          sample: value
            .slice(0, 2)
            .map((item) => summarizeForClient(item, depth + 1)),
        };
  }
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

function makeAction<T>(
  label: string,
  summarize?: (value: T) => unknown,
): MeasureAction<T> {
  const result = summarize ?? summarizeForClient;
  return {
    label,
    start: () => label,
    end: result,
    result,
    maxResultLength: 1200,
  };
}

export function createClientMeasureScope(scopeName: string) {
  const scope: ScopedMeasure = createMeasure(scopeName, {
    maxResultLength: 1200,
  });
  return {
    event(label: string, summary?: unknown) {
      scope.measureSync({
        label,
        maxResultLength: 1200,
        meta: { summary: summarizeForClient(summary) },
      } as MeasureAction);
    },

    async measure<T>(
      label: string,
      operation: () => Promise<T> | T,
      summarize: (value: T) => unknown = summarizeForClient,
    ): Promise<T> {
      const result = await scope.measure(
        makeAction(label, summarize),
        async () => await operation(),
      );
      if (result === null) throw new Error(`measure returned null: ${label}`);
      return result as T;
    },

    measureSync<T>(
      label: string,
      operation: () => T,
      summarize: (value: T) => unknown = summarizeForClient,
    ): T {
      const result = scope.measureSync(makeAction(label, summarize), () =>
        operation(),
      );
      if (result === null)
        throw new Error(`measureSync returned null: ${label}`);
      return result as T;
    },
  };
}
