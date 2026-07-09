function render(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

/**
 * User-facing CLI output goes directly to stdout.
 * Do not wrap stdout/stderr in measure-fn: long-running streams need clean,
 * pipeable output and measure-fn is for scoped instrumentation, not UI text.
 */
export function emit(value: unknown): void {
  const text = render(value);
  if (typeof Bun !== "undefined" && Bun.stdout) Bun.stdout.write(text);
  else process.stdout.write(text);
}

export function emitError(error: unknown): void {
  const rendered =
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : String(error);
  const text = rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  if (typeof Bun !== "undefined" && Bun.stderr) Bun.stderr.write(text);
  else process.stderr.write(text);
}
