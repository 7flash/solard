import { PublicKey, type Commitment, type Connection, type LogsCallback, type LogsFilter } from "@solana/web3.js";
import { createSolardMeasure } from "../core/log.ts";
import { measured, measuredSync } from "../core/measured.ts";

export type EventSource = "sqd" | "rpc";
export type SqdOptions = {
  /** Solana dataset URL. Uses the public mainnet Portal by default. */
  portalUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Inclusive starting slot; omitted means start at the current source head. */
  fromSlot?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
};
export type EventSourceOptions = {
  /** SQD is the default. RPC selects the original WebSocket implementation. */
  source?: EventSource;
  sqd?: SqdOptions;
};
export type EventSourceStatus = (event: string, data?: Record<string, unknown>) => void;
export interface EventLogSource {
  readonly source: EventSource;
  readonly commitment: Commitment;
  readonly closed: Promise<void>;
  /** Original block time when supplied by the source; never observation time. */
  blockTimeMs(signature: string): number | null;
  onLogs(filter: LogsFilter, callback: LogsCallback, commitment?: Commitment): number;
  removeOnLogsListener(id: number): Promise<void>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export function eventSourceCommitment(options: EventSourceOptions & { commitment?: Commitment }): Commitment {
  const requested = options.commitment ?? "processed";
  return (options.source ?? "sqd") === "sqd" && requested !== "processed" && requested !== "recent" ? "finalized" : requested;
}

type PortalTransaction = { transactionIndex: number; signatures: string[]; accountKeys: string[]; err: unknown };
type PortalLog = { transactionIndex: number; logIndex: number; programId: string; kind: string; message: string };
type PortalBlock = {
  header: { number: number; hash: string; parentNumber?: number; parentHash?: string; timestamp?: number };
  transactions?: PortalTransaction[];
  logs?: PortalLog[];
};
const timing = createSolardMeasure("event-source");
const portalLogPositions = new WeakMap<readonly string[], readonly number[]>();
/** Portal rejects an instruction filter with more than 10 values per field. */
const PORTAL_FILTER_VALUES = 10;
const SQD_BATCH_BLOCKS = 512;
const chunks = <T>(values: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, i * size + size));
class PortalHttpError extends Error {
  constructor(status: number, readonly retryAfterMs: number) {
    super([400, 401, 403, 404, 422].includes(status) ? `SQD_FATAL_HTTP_${status}` : `SQD_HTTP_${status}`);
  }
}
function retryAfterMs(response: Response): number {
  const value = response.headers.get("retry-after");
  if (value == null) return 0;
  const duration = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}
/** RPC supplies the complete log array; filtered Portal logs retain their
 * original transaction-wide indices through normalization. */
export function physicalProgramLogIndex(logs: readonly string[], index: number): number {
  return portalLogPositions.get(logs)?.[index] ?? index;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid SQD ${name}`);
  return value;
}

/** Both transports feed the same protocol decoders. Account reads/enrichment stay
 * on the caller's Connection; this source owns no wallet or database. */
export function createEventLogSource(
  connection: Connection,
  options: EventSourceOptions & { commitment?: Commitment; onStatus?: EventSourceStatus;
    programFilters?: Readonly<Record<string, readonly string[]>>;
    /** SQD only: deliver watched-address activity only from these programs' instructions.
     * Portal throughput is bandwidth-bound, so excluding unrelated transactions that merely
     * mention a watched mint (transfers, account creation) keeps large watch sets live. */
    programScope?: readonly string[] } = {},
): EventLogSource {
  const source = options.source ?? "sqd";
  if (source !== "sqd" && source !== "rpc") throw new Error("Invalid event source");
  const requested = options.commitment ?? "processed";
  if (source === "sqd") return new SqdLogSource(options.sqd, requested, options.onStatus, options.programFilters, options.programScope);
  const ids = new Set<number>();
  let settle!: () => void;
  let stopped = false;
  const closed = new Promise<void>(resolve => { settle = resolve; });
  return {
    source, commitment: requested, closed,
    blockTimeMs: () => null,
    onLogs(filter, callback, commitment = requested) {
      if (stopped) throw new Error("Event source is closed");
      const id = connection.onLogs(filter, callback, commitment); ids.add(id); return id;
    },
    async removeOnLogsListener(id) {
      if (ids.delete(id)) await connection.removeOnLogsListener(id);
    },
    async ready() {},
    async close() {
      if (stopped) return closed;
      stopped = true;
      await Promise.allSettled([...ids].map(id => connection.removeOnLogsListener(id)));
      ids.clear(); settle();
    },
  };
}

class SqdLogSource implements EventLogSource {
  readonly source = "sqd";
  readonly commitment: "processed" | "finalized";
  readonly closed: Promise<void>;
  private readonly listeners = new Map<number, { address: string; callback: LogsCallback }>();
  private readonly transactionTimes = new Map<string, number | null>();
  private readonly fetcher: typeof globalThis.fetch;
  private readonly url: string;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly lifetime = new AbortController();
  private request: AbortController | undefined;
  private cursor: number | undefined;
  private parentHash: string | undefined;
  private previousSlot: number | undefined;
  private nextId = 0;
  private revision = 0;
  private running: Promise<void> | undefined;
  private started = false;
  private settle!: () => void;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;
  private readonly readiness: Promise<void>;

  constructor(options: SqdOptions = {}, requested: Commitment, private readonly report?: EventSourceStatus,
    private readonly programFilters?: Readonly<Record<string, readonly string[]>>,
    private readonly programScope?: readonly string[]) {
    // A hot Portal block has no confirmed-status proof. Finalized is a stronger
    // guarantee than confirmed and is used for all non-processed requests.
    this.commitment = requested === "processed" || requested === "recent" ? "processed" : "finalized";
    const url = new URL(options.portalUrl ?? "https://portal.sqd.dev/datasets/solana-mainnet");
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid SQD Portal URL");
    this.url = url.toString().replace(/\/$/, "");
    // Bound: browsers throw "Illegal invocation" when fetch is called as a method of another object.
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.pollMs = positive(options.pollIntervalMs, 1_000, "pollIntervalMs");
    this.timeoutMs = positive(options.requestTimeoutMs, 30_000, "requestTimeoutMs");
    if (options.fromSlot !== undefined && (!Number.isSafeInteger(options.fromSlot) || options.fromSlot < 0))
      throw new Error("Invalid SQD fromSlot");
    this.cursor = options.fromSlot;
    this.closed = new Promise(resolve => { this.settle = resolve; });
    this.readiness = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.readiness.catch(() => {});
  }

  private status(event: string, data: Record<string, unknown> = {}): void {
    try { this.report?.(event, { source: "sqd", commitment: this.commitment, ...data }); } catch {}
  }

  blockTimeMs(signature: string): number | null { return this.transactionTimes.get(signature) ?? null; }

  onLogs(filter: LogsFilter, callback: LogsCallback): number {
    if (this.lifetime.signal.aborted) throw new Error("Event source is closed");
    if (!(filter instanceof PublicKey)) throw new Error("SQD requires an explicit watched program or account");
    const id = ++this.nextId;
    this.listeners.set(id, { address: filter.toBase58(), callback });
    this.changed();
    if (!this.running) this.running = Promise.resolve().then(() => this.run());
    return id;
  }

  async removeOnLogsListener(id: number): Promise<void> {
    if (this.listeners.delete(id)) this.changed();
  }

  private changed(): void { this.revision++; this.request?.abort(); }

  async ready(): Promise<void> {
    if (this.lifetime.signal.aborted) throw new DOMException("Event source closed", "AbortError");
    if (!this.listeners.size && !this.started) return;
    await this.readiness;
  }

  async close(): Promise<void> {
    this.lifetime.abort(); this.request?.abort(); this.listeners.clear(); this.transactionTimes.clear();
    this.rejectReady(new DOMException("Event source closed", "AbortError"));
    if (this.running) await this.running;
    this.settle();
  }

  private async pause(ms: number): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.lifetime.signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, ms);
      this.lifetime.signal.addEventListener("abort", finish, { once: true });
    });
  }

  private async requestHead(): Promise<void> {
    const response = await this.fetcher(`${this.url}/${this.commitment === "finalized" ? "finalized-head" : "head"}`, {
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new PortalHttpError(response.status, retryAfterMs(response));
    }
    const head = await response.json() as { number?: unknown };
    if (!Number.isSafeInteger(head.number) || Number(head.number) < 0) throw new Error("Invalid SQD head");
    this.cursor = Number(head.number);
  }

  private query(): Record<string, unknown> {
    const addresses = [...new Set([...this.listeners.values()].map(value => value.address))];
    const related = { transaction: true, logs: true, innerInstructions: true };
    return {
      type: "solana", fromBlock: this.cursor, includeAllBlocks: true,
      ...(this.parentHash ? { parentBlockHash: this.parentHash } : {}),
      // Watch changes abort and rebuild the request, so the span only bounds a request's
      // lifetime; a short span made per-request latency the throughput limit once lagging.
      toBlock: this.cursor! + SQD_BATCH_BLOCKS - 1,
      fields: {
        block: { number: true, hash: true, parentNumber: true, parentHash: true, timestamp: true },
        transaction: { transactionIndex: true, signatures: true, err: true, accountKeys: true },
        log: { transactionIndex: true, logIndex: true, programId: true, kind: true, message: true },
      },
      instructions: this.programFilters
        ? addresses.map(address => ({ programId: [address], d8: this.programFilters![address], ...related }))
        : this.programScope?.length
          ? chunks(addresses, PORTAL_FILTER_VALUES).map(group => ({ programId: [...this.programScope!], mentionsAccount: group, ...related }))
          : chunks(addresses, PORTAL_FILTER_VALUES).flatMap(group => [
            { mentionsAccount: group, ...related }, { programId: group, ...related },
          ]),
    };
  }

  private deliver(block: PortalBlock): void {
    const header = block?.header;
    if (!header || !Number.isSafeInteger(header.number) || typeof header.hash !== "string")
      throw new Error("Invalid SQD block header");
    if (header.number < this.cursor!) {
      if (header.number === this.previousSlot && header.hash !== this.parentHash) throw new Error("SQD_FORK");
      return;
    }
    if (this.parentHash && (header.parentNumber !== this.previousSlot || header.parentHash !== this.parentHash))
      throw new Error("SQD_FORK");
    const rows = new Map<number, PortalLog[]>();
    for (const log of block.logs ?? []) {
      if (!Number.isSafeInteger(log.transactionIndex) || !Number.isSafeInteger(log.logIndex) ||
          typeof log.programId !== "string" || typeof log.message !== "string") throw new Error("Invalid SQD log");
      const logs = rows.get(log.transactionIndex) ?? []; logs.push(log); rows.set(log.transactionIndex, logs);
    }
    for (const transaction of block.transactions ?? []) {
      if (!Number.isSafeInteger(transaction.transactionIndex) || !Array.isArray(transaction.accountKeys) ||
          !transaction.signatures?.[0] || transaction.err === undefined) throw new Error("Invalid SQD transaction");
      if (transaction.err !== null) continue;
      const blockTime = header.timestamp == null ? null : header.timestamp * 1000;
      this.transactionTimes.set(transaction.signatures[0]!, Number.isSafeInteger(blockTime) ? blockTime : null);
      if (this.transactionTimes.size > 4096) this.transactionTimes.delete(this.transactionTimes.keys().next().value!);
      const logs = (rows.get(transaction.transactionIndex) ?? []).sort((a, b) => a.logIndex - b.logIndex);
      const normalized = logs.flatMap(log => [
        `Program ${log.programId} invoke [1]`,
        log.kind === "data" ? `Program data: ${log.message}` : `Program log: ${log.message}`,
        `Program ${log.programId} success`,
      ]);
      portalLogPositions.set(normalized, logs.flatMap(log => [log.logIndex, log.logIndex, log.logIndex]));
      for (const [id, listener] of this.listeners) {
        if (this.lifetime.signal.aborted || !this.listeners.has(id)) break;
        if (!transaction.accountKeys.includes(listener.address)) continue;
        try { listener.callback({ signature: transaction.signatures[0]!, err: null, logs: normalized }, { slot: header.number }); }
        catch { this.status("source-callback-error"); }
      }
    }
    this.cursor = header.number + 1; this.parentHash = header.hash; this.previousSlot = header.number;
    this.status("source-progress", { nextSlot: this.cursor, atMs: header.timestamp == null ? null : header.timestamp * 1_000 });
  }

  private async consume(response: Response, revision: number): Promise<boolean> {
    if (!response.body) throw new Error("Missing SQD stream body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", received = false;
    const line = (value: string) => {
      if (!value.trim() || revision !== this.revision || this.lifetime.signal.aborted) return;
      measuredSync(timing, "deliver SQD block", () => {
        let block: PortalBlock;
        try { block = JSON.parse(value) as PortalBlock; } catch { throw new Error("Invalid SQD block JSON"); }
        this.deliver(block); return true;
      }, () => ({ nextSlot: this.cursor }));
      received = true;
    };
    try {
      while (revision === this.revision && !this.lifetime.signal.aborted) {
        const result = await reader.read();
        buffer += decoder.decode(result.value, { stream: !result.done });
        if (buffer.length > 16 * 1024 * 1024) throw new Error("SQD block exceeds stream buffer limit");
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
        if (result.done) { line(buffer); break; }
      }
      return received;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  private async run(): Promise<void> {
    let failures = 0;
    try {
      while (!this.lifetime.signal.aborted) {
        if (!this.listeners.size) { await this.pause(this.pollMs); continue; }
        const revision = this.revision;
        let retryAfter = 0;
        try {
          if (this.cursor === undefined) await measured(timing, "SQD head", async () => { await this.requestHead(); return true; }, () => true);
          this.request = new AbortController();
          const response = await measured(timing, "SQD stream request", () => this.fetcher(
            `${this.url}/${this.commitment === "finalized" ? "finalized-stream" : "stream"}`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(this.query()),
              signal: AbortSignal.any([this.lifetime.signal, this.request!.signal, AbortSignal.timeout(this.timeoutMs)]),
            }), value => ({ status: value.status, fromSlot: this.cursor }));
          if (response.status === 409) { await response.body?.cancel(); throw new Error("SQD_FORK"); }
          if (!response.ok && response.status !== 204) {
            await response.body?.cancel();
            throw new PortalHttpError(response.status, retryAfterMs(response));
          }
          if (revision !== this.revision) { await response.body?.cancel(); continue; }
          if (!this.started) { this.started = true; this.status("source-ready"); this.resolveReady(); }
          failures = 0;
          const received = response.status === 204 ? false : await this.consume(response, revision);
          if (!received) await this.pause(this.pollMs);
        } catch (error) {
          if (this.lifetime.signal.aborted) break;
          if (revision !== this.revision) continue;
          if (error instanceof PortalHttpError) retryAfter = error.retryAfterMs;
          const message = error instanceof Error ? error.message : "SQD_ERROR";
          if (message === "SQD_FORK" || message.startsWith("SQD_FATAL_") || message.startsWith("Invalid SQD")) {
            this.status("feed-gap-unverified", { reason: message === "SQD_FORK" ? "source-fork" : "source-invalid-response" });
            this.rejectReady(new Error(message)); break;
          }
          const delayMs = Math.max(retryAfter || 0, Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6)));
          this.status("source-retrying", { delayMs, nextSlot: this.cursor, error: message.slice(0, 200) });
          await this.pause(delayMs);
        }
      }
    } finally {
      this.lifetime.abort(); this.listeners.clear(); this.settle();
      this.rejectReady(new DOMException("Event source stopped", "AbortError"));
    }
  }
}
