import { configure, createMeasure } from "measure-fn";

configure({
  timestamps: true,
  maxResultLength: 1200,
});

export const indexerMeasure = createMeasure("solard:indexer");

export function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.split("\n").slice(0, 4).join("\n"),
    };
  }
  return { message: String(error) };
}

export function summarizeValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "bigint") return value.toString();
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample:
        depth > 1
          ? undefined
          : value.slice(0, 5).map((item) => summarizeValue(item, depth + 1)),
    };
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 32)
        .map(([key, item]) => [
          key,
          /secret|private|apiKey|authorization|cookie/i.test(key)
            ? "[omitted]"
            : summarizeValue(item, depth + 1),
        ]),
    );
  }
  return String(value);
}
