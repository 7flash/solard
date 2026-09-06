export type BacktestErrorCode =
  "INVALID_INPUT" | "INSUFFICIENT_HISTORY" | "INCOMPLETE_HISTORY";

export class BacktestError extends Error {
  readonly name = "BacktestError";

  constructor(
    readonly code: BacktestErrorCode,
    message: string,
    readonly context: Record<string, string | number | boolean | null> = {},
  ) {
    super(message);
  }
}
