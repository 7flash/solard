export type CircuitState = "closed" | "open" | "half-open";

export type CircuitSnapshot = {
  state: CircuitState;
  failures: number;
  openedUntilMs: number | null;
  lastError: string | null;
};

export type CircuitOptions = {
  failureThreshold?: number;
  openMs?: number;
  halfOpenAfterMs?: number;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MetadataCircuitBreaker {
  private failures = 0;
  private openedUntilMs = 0;
  private lastError: string | null = null;
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly halfOpenAfterMs: number;

  constructor(options: CircuitOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 5);
    this.openMs = Math.max(1_000, options.openMs ?? 60_000);
    this.halfOpenAfterMs = Math.max(500, options.halfOpenAfterMs ?? 10_000);
  }

  snapshot(): CircuitSnapshot {
    const now = Date.now();
    return {
      state:
        this.openedUntilMs && now < this.openedUntilMs
          ? now >= this.openedUntilMs - this.openMs + this.halfOpenAfterMs
            ? "half-open"
            : "open"
          : "closed",
      failures: this.failures,
      openedUntilMs: this.openedUntilMs || null,
      lastError: this.lastError,
    };
  }

  canAttempt(): boolean {
    const snap = this.snapshot();
    return snap.state === "closed" || snap.state === "half-open";
  }

  success(): void {
    this.failures = 0;
    this.openedUntilMs = 0;
    this.lastError = null;
  }

  failure(error: unknown, retryAfterMs?: number): void {
    this.failures += 1;
    this.lastError = errorText(error);
    if (this.failures >= this.failureThreshold || retryAfterMs) {
      this.openedUntilMs =
        Date.now() + Math.max(1_000, retryAfterMs ?? this.openMs);
    }
  }
}

export const metadataCircuit = new MetadataCircuitBreaker({
  failureThreshold: Number(process.env.SOLARD_METADATA_CIRCUIT_FAILURES ?? "5"),
  openMs: Number(process.env.SOLARD_METADATA_CIRCUIT_OPEN_MS ?? "60000"),
  halfOpenAfterMs: Number(
    process.env.SOLARD_METADATA_CIRCUIT_HALF_OPEN_AFTER_MS ?? "10000",
  ),
});
