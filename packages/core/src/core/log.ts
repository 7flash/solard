import {
  configure,
  createMeasure,
  measure as globalMeasure,
  measureSync as globalMeasureSync,
  safeStringify,
  summarizeForMeasure,
} from "measure-fn";

import {
  SOLARD_MEASURE_SENSITIVE_KEY_PATTERN,
  solardMeasureRuntimeOptions,
  type SolardMeasureRuntimeOptions,
} from "./measure-policy.ts";

// Library default is quiet. Applications decide when/how measurements are
// emitted. The redaction policy is still installed immediately so an app that
// later enables output cannot accidentally start from an unsafe default.
configure({
  silent: true,
  sensitiveKeyPattern: SOLARD_MEASURE_SENSITIVE_KEY_PATTERN,
});

export type SolardMeasureEvent = {
  type: "start" | "success" | "error" | "annotation" | string;
  id?: string;
  label?: string;
  depth?: number;
  duration?: number;
  result?: unknown;
  error?: unknown;
  meta?: Record<string, unknown>;
  budget?: number;
  maxResultLength?: number;
};

export type SolardMeasureOptions = Partial<SolardMeasureRuntimeOptions> & {
  logger?: ((event: SolardMeasureEvent) => void) | null;
};

export type SolardMeasureLabelSummary = {
  label: string;
  calls: number;
  successes: number;
  errors: number;
  totalMs: number;
  maxMs: number;
};

export type SolardMeasureSummary = {
  completed: number;
  successes: number;
  errors: number;
  annotations: number;
  measuredMs: number;
  maxMs: number;
  labels: SolardMeasureLabelSummary[];
};

export type SolardMeasureCollector = {
  logger: (event: SolardMeasureEvent) => void;
  snapshot(): SolardMeasureSummary;
  reset(): void;
};

/**
 * Configure measure-fn globally for a Solard application.
 *
 * Runtime defaults come from the SOLARD_MEASURE_* environment variables in one
 * place (`measure-policy.ts`). Explicit options always win. This function is
 * intentionally reconfigurable because the CLI installs its aggregate logger
 * after parsing flags such as --measure-stream.
 */
export function configureSolardMeasure(
  options: SolardMeasureOptions = {},
): void {
  const defaults = solardMeasureRuntimeOptions();
  configure({
    ...defaults,
    ...options,
    logger: options.logger === undefined ? undefined : options.logger,
  });
}

/**
 * Collect completed measure-fn events without streaming them to stdout/stderr.
 *
 * measuredMs is the sum of completed spans, so nested spans can overlap. It is
 * useful as instrumentation work, not as wall-clock command duration.
 */
export function createSolardMeasureCollector(): SolardMeasureCollector {
  let completed = 0;
  let successes = 0;
  let errors = 0;
  let annotations = 0;
  let measuredMs = 0;
  let maxMs = 0;
  const labels = new Map<string, SolardMeasureLabelSummary>();

  const reset = () => {
    completed = 0;
    successes = 0;
    errors = 0;
    annotations = 0;
    measuredMs = 0;
    maxMs = 0;
    labels.clear();
  };

  const logger = (event: SolardMeasureEvent) => {
    if (event.type === "annotation") {
      annotations += 1;
      return;
    }

    if (event.type !== "success" && event.type !== "error") return;

    const duration =
      typeof event.duration === "number" && Number.isFinite(event.duration)
        ? Math.max(0, event.duration)
        : 0;
    const label = String(event.label ?? "(unlabelled)");

    completed += 1;
    measuredMs += duration;
    maxMs = Math.max(maxMs, duration);
    if (event.type === "success") successes += 1;
    else errors += 1;

    const row = labels.get(label) ?? {
      label,
      calls: 0,
      successes: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
    };
    row.calls += 1;
    row.totalMs += duration;
    row.maxMs = Math.max(row.maxMs, duration);
    if (event.type === "success") row.successes += 1;
    else row.errors += 1;
    labels.set(label, row);
  };

  return {
    logger,
    snapshot() {
      return {
        completed,
        successes,
        errors,
        annotations,
        measuredMs,
        maxMs,
        labels: [...labels.values()].sort((left, right) =>
          left.totalMs === right.totalMs
            ? left.label.localeCompare(right.label)
            : right.totalMs - left.totalMs,
        ),
      };
    },
    reset,
  };
}

/** Preferred scoped measurement constructor for new Solard code. */
export function createSolardMeasure(scope: string) {
  const normalized = scope.trim();
  if (!normalized) throw new Error("Solard measure scope is required");
  return createMeasure(`slrd:${normalized}`, { maxResultLength: 1600 });
}

/** @deprecated Prefer createSolardMeasure(scope). */
export const measure = createSolardMeasure;

// Explicit names for measure-fn's process-global helpers. `measure` is already
// the long-standing Solard scope factory above, so exposing the raw helpers
// under unambiguous names prevents accidental imports of the wrong API.
export {
  createMeasure,
  globalMeasure as rawMeasure,
  globalMeasureSync as rawMeasureSync,
  safeStringify,
  summarizeForMeasure,
};

export const apiMeasure = createMeasure("solard:api");
export const dbMeasure = createMeasure("solard:db");
export const workerMeasure = createMeasure("solard:worker");
export const processMeasure = createMeasure("solard:process");
export const indexerMeasure = createMeasure("solard:indexer");

export const DB_RETRY = {
  attempts: 5,
  delay: 20,
  backoff: 2,
} as const;

export function compactId(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function shortKey(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-6)}`;
}

type ErrorWithSqliteFields = Error & {
  code?: unknown;
  errno?: unknown;
  byteOffset?: unknown;
};

function stackLines(error: Error, limit = 10): string[] {
  return String(error.stack ?? `${error.name}: ${error.message}`)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, Math.max(1, limit));
}

function firstApplicationFrame(stack: readonly string[]): string | undefined {
  return stack.find(
    (line, index) =>
      index > 0 &&
      !line.includes("node_modules/measure-fn") &&
      !line.includes("node:internal") &&
      !line.includes("bun:sqlite"),
  );
}

function summarizeCause(cause: unknown, depth: number): unknown {
  if (cause == null) return undefined;

  if (cause instanceof Error && depth < 2) {
    return summarizeErrorInternal(cause, depth + 1);
  }

  return cause instanceof Error
    ? { name: cause.name, message: cause.message }
    : cause;
}

function summarizeErrorInternal(
  error: unknown,
  depth: number,
): Record<string, unknown> {
  if (error instanceof Error) {
    const sqlite = error as ErrorWithSqliteFields;
    const stack = stackLines(error);
    return {
      name: error.name,
      message: error.message,
      code: sqlite.code,
      errno: sqlite.errno,
      byteOffset: sqlite.byteOffset,
      location: firstApplicationFrame(stack),
      stack,
      cause: summarizeCause(error.cause, depth),
    };
  }

  return { message: String(error) };
}

export function summarizeError(error: unknown): Record<string, unknown> {
  return summarizeErrorInternal(error, 0);
}
