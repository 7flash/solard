import { configure, createMeasure } from "measure-fn";

configure({ timestamps: true, maxResultLength: 1200 });

export const indexerMeasure = createMeasure("solard:indexer");

export function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.split("\n").slice(0, 4).join("\n"),
      cause: error.cause == null ? undefined : summarizeError(error.cause),
    };
  }
  return { message: String(error) };
}

export function summarizeValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    return value.length > 220
      ? `${value.slice(0, 120)}…${value.slice(-32)} (${value.length} chars)`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= 2) return { type: "array", length: value.length };
    return {
      type: "array",
      length: value.length,
      sample: value.slice(0, 5).map((item) => summarizeValue(item, depth + 1)),
    };
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    ).slice(0, 32)) {
      out[key] =
        /secret|private|token|apiKey|api_key|authorization|cookie/i.test(key)
          ? "[omitted]"
          : summarizeValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}
