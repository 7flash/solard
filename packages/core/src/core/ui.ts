import { createMeasure } from "measure-fn";

const ui = createMeasure("slrd:ui");

function render(value: unknown): string {
  if (typeof value === "string") return value.replace(/\n$/, "");
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

/**
 * User-facing CLI output must be real stdout. measure-fn is for operation
 * scopes, not for every printed terminal row. Set SOLARD_MEASURE_UI=1 only
 * when debugging the UI/output channel itself.
 */
export function emit(value: unknown): void {
  const rendered = render(value);
  if (process.env.SOLARD_MEASURE_UI === "1") {
    ui.measureSync(
      { start: () => "output", end: (result) => result },
      () => rendered,
    );
  }
  process.stdout.write(`${rendered}\n`);
}

export function emitError(error: unknown): void {
  const rendered =
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : String(error);
  if (process.env.SOLARD_MEASURE_UI === "1") {
    ui.measureSync("error", () => rendered);
  }
  process.stderr.write(`${rendered}\n`);
}
