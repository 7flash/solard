import { configure, createMeasure } from "measure-fn";

// Library default is quiet. Applications can opt into raw streaming, inject a
// custom telemetry logger, or use the built-in aggregate collector below.
configure({ silent: true });

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

export type SolardMeasureOptions = {
  silent?: boolean;
  logger?: ((event: SolardMeasureEvent) => void) | null;
  timestamps?: boolean;
  maxResultLength?: number;
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
 * Configure measure-fn globally for Solard.
 *
 * `logger` is the clean integration point:
 * - logger: customTelemetry => measurements are emitted there
 * - logger: () => {}       => measurements run, events are discarded
 * - silent: true           => measure-fn does not emit logger events at all
 *
 * The setting is live and applies to already-created scoped measures.
 */
export function configureSolardMeasure(
  options: SolardMeasureOptions = {},
): void {
  configure({
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

export function measure(scope: string) {
  return createMeasure(`slrd:${scope}`, { maxResultLength: 1600 });
}

export function shortKey(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-6)}`;
}
