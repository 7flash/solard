import { configure, createMeasure } from "measure-fn";

configure({ timestamps: true, maxResultLength: 1200 });

export type ClientMeasureEntry = {
  id: string;
  atMs: number;
  scope: string;
  label: string;
  status: "ok" | "error" | "event";
  tookMs: number;
  summary?: unknown;
  error?: unknown;
};

const scopes = new Map<string, ReturnType<typeof createMeasure>>();
const entries: ClientMeasureEntry[] = [];
const listeners = new Set<() => void>();
const MAX = 120;

function scopeFor(scope: string) {
  const key = scope || "solard:web";
  const existing = scopes.get(key);
  if (existing) return existing;
  const created = createMeasure(key);
  scopes.set(key, created);
  return created;
}

function summarize(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length > 220
      ? `${value.slice(0, 120)}…${value.slice(-32)} (${value.length} chars)`
      : value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      cause: summarize(value.cause, depth + 1),
    };
  }
  if (Array.isArray(value)) {
    if (depth >= 2) return { type: "array", length: value.length };
    return {
      type: "array",
      length: value.length,
      sample: value.slice(0, 4).map((item) => summarize(item, depth + 1)),
    };
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const input = value as Record<string, unknown>;
    for (const key of Object.keys(input).slice(0, 32)) {
      if (
        /secret|private|mnemonic|seed|keypair|password|authorization|cookie|token|apikey|api_key/i.test(
          key,
        )
      ) {
        out[key] = "[omitted]";
      } else {
        out[key] = summarize(input[key], depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      cause: summarize(error.cause),
    };
  }
  return { message: String(error) };
}

function push(row: Omit<ClientMeasureEntry, "id" | "atMs">): void {
  const entry: ClientMeasureEntry = {
    id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
    atMs: Date.now(),
    ...row,
    summary: summarize(row.summary),
    error: summarize(row.error),
  };
  entries.unshift(entry);
  entries.splice(MAX);

  const marker =
    entry.status === "error" ? "✗" : entry.status === "event" ? "•" : "✓";
  console.debug(
    `[${entry.scope}] ${marker} ${entry.label} ${entry.tookMs.toFixed(1)}ms`,
    entry.error ?? entry.summary ?? {},
  );

  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // subscriber failures must not break the page
    }
  }
}

export function getClientMeasureEntries(): ClientMeasureEntry[] {
  return [...entries];
}

export function subscribeClientMeasure(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearClientMeasureEntries(): void {
  entries.length = 0;
  for (const listener of listeners) listener();
}

export function measureEvent(
  scope: string,
  label: string,
  summary?: unknown,
): void {
  const start = performance.now();
  const meter = scopeFor(scope);
  const safe = summarize(summary);
  try {
    meter.measureSync(
      {
        start: () => label,
        end: () => ({ event: safe }),
      },
      () => safe ?? "ok",
    );
  } finally {
    push({
      scope,
      label,
      status: "event",
      tookMs: performance.now() - start,
      summary: safe,
    });
  }
}

export async function measureClient<T>(
  args: {
    scope: string;
    start: () => string;
    end?: (value: T) => unknown;
    catch?: (error: unknown) => unknown;
  },
  fn: () => Promise<T> | T,
): Promise<T> {
  const scope = args.scope || "solard:web";
  const label = args.start();
  const meter = scopeFor(scope);
  const startedAt = performance.now();
  let resultSummary: unknown;

  try {
    const value = await meter.measure(
      {
        start: () => label,
        end: (value: T) => {
          resultSummary = args.end ? args.end(value) : summarize(value);
          return resultSummary;
        },
        catch: (error: unknown) => {
          resultSummary = args.catch
            ? args.catch(error)
            : summarizeError(error);
          return resultSummary;
        },
      },
      async () => await fn(),
    );

    push({
      scope,
      label,
      status: "ok",
      tookMs: performance.now() - startedAt,
      summary: resultSummary,
    });

    return value;
  } catch (error) {
    push({
      scope,
      label,
      status: "error",
      tookMs: performance.now() - startedAt,
      error: resultSummary ?? summarizeError(error),
    });
    throw error;
  }
}
