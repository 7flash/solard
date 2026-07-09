import { configure, createMeasure } from "measure-fn";

configure({
  timestamps: true,
  maxResultLength: 1200,
});

const SENSITIVE_KEY =
  /secret|private|mnemonic|seed|keypair|password|authorization|cookie|token|apikey|api_key/i;

type ScopedMeasure = ReturnType<typeof createMeasure>;

export function summarizeForClient(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string")
    return value.length > 180
      ? `${value.slice(0, 90)}…${value.slice(-24)} (${value.length} chars)`
      : value;
  if (value instanceof Error)
    return {
      name: value.name,
      message: value.message,
      cause: summarizeForClient(value.cause),
    };
  if (Array.isArray(value)) {
    return depth >= 2
      ? { type: "array", length: value.length }
      : {
          type: "array",
          length: value.length,
          sample: value
            .slice(0, 3)
            .map((item) => summarizeForClient(item, depth + 1)),
        };
  }
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const keys = Object.keys(input);
    const out: Record<string, unknown> = { type: "object", keys: keys.length };
    for (const key of keys.slice(0, 28)) {
      if (SENSITIVE_KEY.test(key)) out[key] = "[omitted]";
      else out[key] = summarizeForClient(input[key], depth + 1);
    }
    if (keys.length > 28) out.omittedKeys = keys.length - 28;
    return out;
  }
  return String(value);
}

export function createClientMeasureScope(scopeName: string) {
  const scope: ScopedMeasure = createMeasure(scopeName);
  return {
    event(label: string, summary?: unknown) {
      scope.measureSync(
        {
          start: () => label,
          end: () => ({ event: summarizeForClient(summary) }),
        },
        () => summary ?? "ok",
      );
    },

    async measure<T>(
      label: string,
      operation: () => Promise<T> | T,
      summarize: (value: T) => unknown = summarizeForClient,
    ): Promise<T> {
      return await scope.measure(
        {
          start: () => label,
          end: (value: T) => summarize(value),
          catch: (error: unknown) => {
            throw error;
          },
        },
        async () => await operation(),
      );
    },

    measureSync<T>(
      label: string,
      operation: () => T,
      summarize: (value: T) => unknown = summarizeForClient,
    ): T {
      return scope.measureSync(
        {
          start: () => label,
          end: (value: T) => summarize(value),
          catch: (error: unknown) => {
            throw error;
          },
        },
        () => operation(),
      );
    },
  };
}
