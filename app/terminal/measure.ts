import { createMeasure } from "measure-fn";

export const terminalUiMeasure = createMeasure("solard:web:terminal");

export const terminalFeedMeasure = createMeasure("solard:web:terminal:feed");

export const terminalTradeMeasure = createMeasure("solard:web:terminal:trade");

export const terminalHoldersMeasure = createMeasure(
  "solard:web:terminal:holders",
);

export function compactId(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) {
    return value;
  }

  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const stack = String(error.stack ?? `${error.name}: ${error.message}`)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 10);

    return {
      name: error.name,

      message: error.message,

      location: stack.find(
        (line, index) => index > 0 && !line.includes("node_modules/measure-fn"),
      ),

      stack,

      cause:
        error.cause instanceof Error
          ? {
              name: error.cause.name,

              message: error.cause.message,
            }
          : error.cause,
    };
  }

  return {
    message: String(error),
  };
}
