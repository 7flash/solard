/** A route/build/local simulation failure is not an uncertain broadcast. */
export class TradePreSubmissionError extends Error {
  readonly phase = "before-submission" as const;
  readonly code: string;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TradePreSubmissionError";
    let code = "TRADE_NOT_SUBMITTED";
    let current = cause;
    const seen = new Set<object>();
    for (
      let depth = 0;
      depth < 8 && current && typeof current === "object" && !seen.has(current);
      depth++
    ) {
      seen.add(current);
      const value = current as Record<string, unknown>;
      if (code === "TRADE_NOT_SUBMITTED" && typeof value.code === "string")
        code = value.code;
      for (const key of [
        "quotedMinimum",
        "requiredMinimum",
        "requiredLamports",
        "availableLamports",
        "retryable",
        "limitPriceSol",
        "side",
        "expectedOutputLamports",
        "networkFeeLamports",
        "tipLamports",
        "requiredOutputLamports",
        "outputSource",
      ])
        if (key in value && !(key in this))
          Object.assign(this, { [key]: value[key] });
      current = value.cause;
    }
    this.code = code;
  }
}
