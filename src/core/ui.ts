import { createMeasure } from "measure-fn";

const ui = createMeasure("sowl:ui", { maxResultLength: 5000 });

/** User-facing command output is still emitted through measure-fn so every
 * observable operation has one consistent structured log stream. */
export function emit(value: unknown): void {
  const rendered = typeof value === "string" ? value.replace(/\n$/, "") : value;
  ui.measureSync("output", () => rendered);
}

export function emitError(error: unknown): void {
  const rendered = error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error);
  ui.measureSync(`[fatal] ${rendered}`);
}
