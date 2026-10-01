/** A route/build/local simulation failure is not an uncertain broadcast. */
export class TradePreSubmissionError extends Error {
  readonly phase = "before-submission" as const;
  readonly code: string;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TradePreSubmissionError";
    this.code = typeof cause === "object" && cause !== null && "code" in cause &&
      typeof cause.code === "string" ? cause.code : "TRADE_NOT_SUBMITTED";
    if (cause && typeof cause === "object") {
      for (const key of ["quotedMinimum", "requiredMinimum", "requiredLamports", "availableLamports"])
        if (key in cause) Object.assign(this, { [key]: (cause as Record<string, unknown>)[key] });
    }
  }
}
