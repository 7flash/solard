import { createMeasure } from "measure-fn";

const shouldMeasureUi =
  process.env.SOLARD_MEASURE_UI === "1" ||
  process.env.SOLWAL_MEASURE_UI === "1";
const ui = shouldMeasureUi
  ? createMeasure("sowl:ui", { maxResultLength: 5000 })
  : null;

function render(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

/**
 * User-facing CLI output must be real stdout, not measure-fn output.
 * measure-fn is still available for UI output when explicitly enabled with
 * SOLARD_MEASURE_UI=1, but streaming commands default to clean stdout so they
 * can be piped, grepped, or consumed as JSONL.
 */
export function emit(value: unknown): void {
  const text = render(value);
  if (ui) {
    const measured = text.replace(/\n$/, "");
    ui.measureSync("output", () => measured);
  }
  if (typeof Bun !== "undefined" && Bun.stdout) Bun.stdout.write(text);
  else process.stdout.write(text);
}

export function emitError(error: unknown): void {
  const rendered =
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : String(error);
  if (ui) ui.measureSync("fatal", () => rendered);
  if (typeof Bun !== "undefined" && Bun.stderr)
    Bun.stderr.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
  else
    process.stderr.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
}
