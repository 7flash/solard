import {
  configure,
  createMeasure,
  measure,
  measureSync,
  safeStringify,
  summarizeForMeasure,
} from "measure-fn";

let configured = false;

function readIntEnv(name: string, fallback: number, max = 10_000): number {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return Math.min(Math.floor(value), max);
}

export function configureSolardMeasure(): void {
  if (configured) {
    return;
  }

  configured = true;

  configure({
    timestamps: process.env.SOLARD_MEASURE_TIMESTAMPS !== "0",

    silent:
      process.env.SOLARD_MEASURE === "0" ||
      process.env.SOLARD_MEASURE_SILENT === "1",

    maxResultLength: readIntEnv("SOLARD_MEASURE_MAX_RESULT_LENGTH", 900),

    summarize: true,
    stripScopePrefix: true,

    maxSummaryDepth: readIntEnv("SOLARD_MEASURE_MAX_SUMMARY_DEPTH", 4, 20),

    maxSummaryStringLength: readIntEnv(
      "SOLARD_MEASURE_MAX_SUMMARY_STRING_LENGTH",
      160,
      2_000,
    ),

    summaryArraySample: readIntEnv("SOLARD_MEASURE_ARRAY_SAMPLE", 2, 20),

    summaryObjectKeys: readIntEnv("SOLARD_MEASURE_OBJECT_KEYS", 24, 200),

    sensitiveKeyPattern:
      /secret|private|mnemonic|seed|keypair|password|authorization|cookie|token|apikey|api_key|rpc_endpoint|rpc_url|sender_url|endpoint|url/i,
  });
}

configureSolardMeasure();

export {
  createMeasure,
  measure,
  measureSync,
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
  if (value.length <= head + tail + 1) {
    return value;
  }

  return `${value.slice(0, head)}…${value.slice(-tail)}`;
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
  if (cause == null) {
    return undefined;
  }

  if (cause instanceof Error && depth < 2) {
    return summarizeErrorInternal(cause, depth + 1);
  }

  return cause instanceof Error
    ? {
        name: cause.name,

        message: cause.message,
      }
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

  return {
    message: String(error),
  };
}

export function summarizeError(error: unknown): Record<string, unknown> {
  return summarizeErrorInternal(error, 0);
}
