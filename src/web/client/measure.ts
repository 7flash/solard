export type ClientMeasureEvent = {
  id: number;
  parentId: number | null;
  scope: string;
  label: string;
  status: "start" | "ok" | "error" | "event";
  atMs: number;
  tookMs?: number;
  summary?: unknown;
  error?: string;
};

const MAX_EVENTS = 240;
const SENSITIVE_KEY =
  /secret|private|mnemonic|seed|keypair|password|authorization|cookie|token/i;

function now(): number {
  return Date.now();
}

export function summarizeForClient(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string")
    return value.length > 140
      ? `${value.slice(0, 70)}…${value.slice(-20)} (${value.length} chars)`
      : value;
  if (value instanceof Error)
    return { name: value.name, message: value.message };
  if (Array.isArray(value))
    return depth >= 2
      ? { type: "array", length: value.length }
      : {
          type: "array",
          length: value.length,
          sample: value
            .slice(0, 2)
            .map((item) => summarizeForClient(item, depth + 1)),
        };
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const keys = Object.keys(input);
    const out: Record<string, unknown> = { type: "object", keys: keys.length };
    for (const key of keys.slice(0, 24)) {
      if (SENSITIVE_KEY.test(key)) out[key] = "[omitted]";
      else if (Array.isArray(input[key]))
        out[key] = { type: "array", length: (input[key] as unknown[]).length };
      else
        out[key] =
          depth >= 2 && input[key] && typeof input[key] === "object"
            ? {
                type: "object",
                keys: Object.keys(input[key] as Record<string, unknown>).length,
              }
            : summarizeForClient(input[key], depth + 1);
    }
    if (keys.length > 24) out.omittedKeys = keys.length - 24;
    return out;
  }
  return String(value);
}

function eventKey(event: ClientMeasureEvent): string {
  return `${event.id}:${event.status}:${event.label}`;
}

class ClientMeasureStore {
  private seq = 0;
  private stack: number[] = [];
  events: ClientMeasureEvent[] = [];

  snapshot(): ClientMeasureEvent[] {
    return [...this.events];
  }

  push(
    event: Omit<ClientMeasureEvent, "id" | "parentId" | "atMs"> & {
      parentId?: number | null;
      atMs?: number;
    },
  ): ClientMeasureEvent {
    const item: ClientMeasureEvent = {
      id: ++this.seq,
      parentId:
        event.parentId === undefined
          ? (this.stack[this.stack.length - 1] ?? null)
          : event.parentId,
      atMs: event.atMs ?? now(),
      ...event,
    };
    this.events = [
      ...this.events.filter(
        (existing) => eventKey(existing) !== eventKey(item),
      ),
      item,
    ].slice(-MAX_EVENTS);
    return item;
  }

  async measure<T>(
    scope: string,
    label: string,
    fn: () => Promise<T> | T,
    summarize: (value: T) => unknown = summarizeForClient,
  ): Promise<T> {
    const start = this.push({ scope, label, status: "start" });
    this.stack.push(start.id);
    const started = now();
    try {
      const value = await fn();
      this.push({
        scope,
        label,
        status: "ok",
        parentId: start.parentId,
        tookMs: now() - started,
        summary: summarize(value),
      });
      return value;
    } catch (error) {
      this.push({
        scope,
        label,
        status: "error",
        parentId: start.parentId,
        tookMs: now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      const index = this.stack.lastIndexOf(start.id);
      if (index >= 0) this.stack.splice(index, 1);
    }
  }

  sync<T>(
    scope: string,
    label: string,
    fn: () => T,
    summarize: (value: T) => unknown = summarizeForClient,
  ): T {
    const start = this.push({ scope, label, status: "start" });
    this.stack.push(start.id);
    const started = now();
    try {
      const value = fn();
      this.push({
        scope,
        label,
        status: "ok",
        parentId: start.parentId,
        tookMs: now() - started,
        summary: summarize(value),
      });
      return value;
    } catch (error) {
      this.push({
        scope,
        label,
        status: "error",
        parentId: start.parentId,
        tookMs: now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      const index = this.stack.lastIndexOf(start.id);
      if (index >= 0) this.stack.splice(index, 1);
    }
  }

  event(scope: string, label: string, summary?: unknown): void {
    this.push({
      scope,
      label,
      status: "event",
      summary: summarizeForClient(summary),
    });
  }
}

export const clientMeasureStore = new ClientMeasureStore();

export function createClientMeasureScope(scope: string) {
  return {
    event(label: string, summary?: unknown) {
      clientMeasureStore.event(scope, label, summary);
    },
    measure<T>(
      label: string,
      fn: () => Promise<T> | T,
      summarize?: (value: T) => unknown,
    ) {
      return clientMeasureStore.measure(scope, label, fn, summarize);
    },
    measureSync<T>(
      label: string,
      fn: () => T,
      summarize?: (value: T) => unknown,
    ) {
      return clientMeasureStore.sync(scope, label, fn, summarize);
    },
    snapshot() {
      return clientMeasureStore.snapshot();
    },
  };
}
