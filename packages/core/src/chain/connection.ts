import { Connection, type Commitment, type FetchFn } from "@solana/web3.js";

import { MissingConfigError } from "../core/errors.ts";
import { createSolardMeasure } from "../core/log.ts";
import { measured, measuredSync } from "../core/measured.ts";
import { waitForRpcPriority } from "./rpc-priority.ts";
import {traceSolardRpcRequest,traceSolardRpcHttp,markSolardRpcQueued,traceSolardRpcOperation} from './rpc-observer.ts';
const rpcMeasure = createSolardMeasure("rpc-transport");
const connectionTransports=new WeakMap<Connection,FetchFn>();
/** Raw history batches retain their owning connection's queue and endpoint pool. */
export function solardConnectionFetch(connection:Connection,input:RequestInfo|URL,init?:RequestInit,options:SolardRpcFetchOptions={}){
  const transport=connectionTransports.get(connection);
  return transport?transport(input,init):solardRpcFetch(input,init,options);
}
function rpcMethod(body: unknown): string {
  try {
    const data = typeof body === "string" ? JSON.parse(body) : null;
    return Array.isArray(data) ? "batch" : typeof data?.method === "string" && /^[a-zA-Z0-9_]+$/.test(data.method) ? data.method : "request";
  } catch { return "request"; }
}
import { SharedRpcWindow, rpcGateDbPath, rpcRequestCost } from "./shared-rpc-window.ts";
import {resolveRpcPacer,type RpcPacingOptions,type RpcPacer} from './rpc-pacer.ts';
import { sharedRpcScheduler, providerBudget, rpcSafeEndpoint, MAINNET_GENESIS, READINESS_ADDRESS } from "./rpc-scheduler.ts";

export type SolardRpcStats = {
  maxRps: number;
  requestStarts: number;
  responses: number;
  rateLimited429: number;
  retries429: number;
  networkErrors: number;
  retriesNetwork: number;
  finalNetworkErrors: number;
  finalHttpErrors: number;
  gateWaitMs: number;
};

const rpcStats: SolardRpcStats = {
  maxRps: 5,
  requestStarts: 0,
  responses: 0,
  rateLimited429: 0,
  retries429: 0,
  networkErrors: 0,
  retriesNetwork: 0,
  finalNetworkErrors: 0,
  finalHttpErrors: 0,
  gateWaitMs: 0,
};

export function getSolardRpcStats(): SolardRpcStats {
  return { ...rpcStats };
}

export function resetSolardRpcStats(): void {
  rpcStats.maxRps = 5;
  rpcStats.requestStarts = 0;
  rpcStats.responses = 0;
  rpcStats.rateLimited429 = 0;
  rpcStats.retries429 = 0;
  rpcStats.networkErrors = 0;
  rpcStats.retriesNetwork = 0;
  rpcStats.finalNetworkErrors = 0;
  rpcStats.finalHttpErrors = 0;
  rpcStats.gateWaitMs = 0;
}

const sleep = (ms: number) =>
  ms > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

function envInt(name: string, fallback: number, minimum = 0): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.trunc(parsed))
    : fallback;
}

function retryAfterMs(response: Response, fallbackMs: number): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return fallbackMs;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(fallbackMs, Math.ceil(seconds * 1000));
  }

  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    return Math.max(fallbackMs, date - Date.now());
  }

  return fallbackMs;
}

/**
 * One JSON-RPC sliding-window gate, process-wide by default.
 *
 * A provider limit of 5 RPS means every caller in the process shares the same
 * request budget. rpcGateDbPath() (default ~/.solard/rpc-gate.sqlite) shares atomic reservations between processes
 * configured with the same window limits. Network calls never hold SQLite locks.
 */
const rpcWindows = new Map<string, SharedRpcWindow>();

async function acquireRpcSlot(maxRps: number, body?: unknown): Promise<void> {
  const path = rpcGateDbPath() ?? "";
  let window = rpcWindows.get(path);
  if (!window) {
    window = new SharedRpcWindow(path || undefined);
    rpcWindows.set(path, window);
  }
  const cost = rpcRequestCost(body);
  const options = {
    maxRequests: envInt("SLRD_RPC_MAX_REQUESTS", maxRps, 1),
    windowMs: envInt("SLRD_RPC_WINDOW_MS", 1100, 1),
    maxSends: envInt("SLRD_RPC_MAX_SENDS", 1, 1),
    sendWindowMs: envInt("SLRD_RPC_SEND_WINDOW_MS", 1000, 1),
  };
  while (true) {
    markSolardRpcQueued();
    await waitForRpcPriority();
    const delayMs = window.reserve(options, cost.requests, cost.sends);
    if (!delayMs) {
      rpcStats.requestStarts += 1;
      return;
    }
    rpcStats.gateWaitMs += delayMs;
    await sleep(delayMs);
  }
}

export type SolardRpcFetchOptions = {
  fetch?: FetchFn;
  /** Disable transport-level 429 retries when the caller owns retry/backoff. */
  retry429?: boolean;
  /** Disable retries for fetch-level transport failures such as ECONNRESET. */
  retryNetwork?: boolean;
  /** Pool owns provider/group/aggregate admission. */
  poolScheduled?: boolean;
};

/**
 * Process-wide JSON-RPC transport shared by web3.js and explicit RPC clients.
 *
 * All callers pass through the same start-rate gate and stats. A subsystem that
 * needs an observable/adaptive retry policy can set retry429=false so there is
 * exactly one retry loop instead of stacking retries here and at the caller.
 */
export async function solardRpcFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: SolardRpcFetchOptions = {},
): Promise<Response> {
  return await traceSolardRpcRequest(input,init,()=>solardRpcFetchInternal(input,init,options));
}
async function solardRpcFetchInternal(input:RequestInfo|URL,init:RequestInit|undefined,options:SolardRpcFetchOptions):Promise<Response>{
  // web3.js history loaders use large JSON-RPC batches. Split them into gated
  // starts while retaining every JSON-RPC id and the caller's response shape.
  if (typeof init?.body === "string") {
    let batch: unknown;
    try {
      batch = JSON.parse(init.body);
    } catch {}
    if (Array.isArray(batch)) {
      const requestBudget = envInt(
        "SLRD_RPC_MAX_REQUESTS",
        envInt("SLRD_RPC_MAX_RPS", 5, 1),
        1,
      );
      const sendBudget = envInt("SLRD_RPC_MAX_SENDS", 1, 1);
      const chunks: Array<Array<unknown>> = [];
      let chunk: Array<unknown> = [];
      let sends = 0;
      for (const request of batch) {
        const isSend =
          typeof request === "object" &&
          request !== null &&
          "method" in request &&
          request.method === "sendTransaction";
        if (chunk.length >= requestBudget || (isSend && sends >= sendBudget)) {
          chunks.push(chunk);
          chunk = [];
          sends = 0;
        }
        chunk.push(request);
        if (isSend) sends++;
      }
      if (chunk.length) chunks.push(chunk);
      if (chunks.length > 1) {
        const results: Array<unknown> = [];
        for (const requests of chunks) {
          const response = await solardRpcFetch(
            input,
            { ...init, body: JSON.stringify(requests) },
            options,
          );
          if (!response.ok) return response;
          const body: unknown = await response.json();
          if (!Array.isArray(body))
            throw new Error("RPC batch response must be an array");
          results.push(...body);
        }
        return new Response(JSON.stringify(results), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
  }
  const signedSend = rpcRequestCost(init?.body).sends > 0;
  // Fee suggestions are optional and bounded at the caller. Retrying a rejected
  // suggestion competes with the actual trade for RPC quota.
  const optionalFeeRead = rpcMethod(init?.body) === "getRecentPrioritizationFees";
  const maxRps = envInt("SLRD_RPC_MAX_RPS", 5, 1);
  const max429Retries =
    options.retry429 === false || signedSend || optionalFeeRead ? 0 : envInt("SLRD_RPC_429_RETRIES", 6, 0);
  const base429DelayMs = envInt("SLRD_RPC_429_BASE_DELAY_MS", 500, 1);
  const max429DelayMs = envInt("SLRD_RPC_429_MAX_DELAY_MS", 8_000, 1);
  const maxNetworkRetries =
    options.retryNetwork === false || signedSend || optionalFeeRead
      ? 0
      : envInt("SLRD_RPC_NETWORK_RETRIES", 4, 0);
  const networkBaseDelayMs = envInt("SLRD_RPC_NETWORK_BASE_DELAY_MS", 250, 1);
  const networkMaxDelayMs = envInt("SLRD_RPC_NETWORK_MAX_DELAY_MS", 4_000, 1);
  const debug =
    process.env.SLRD_RPC_RETRY_LOG === "1" ||
    process.env.SLRD_RPC_RETRY_LOG === "true";

  rpcStats.maxRps = maxRps;
  let attempt429 = 0;
  let attemptNetwork = 0;

  while (true) {
    if (!options.poolScheduled) await measured(rpcMeasure, `${rpcMethod(init?.body)} queue`, async () => { await acquireRpcSlot(maxRps, init?.body); return true; }, () => undefined);
    else rpcStats.requestStarts++;

    let response: Response;
    try {
      response = await measured(rpcMeasure, `${rpcMethod(init?.body)} network attempt ${attempt429 + attemptNetwork + 1}`, () => options.fetch?options.fetch(input,init):traceSolardRpcHttp(input,init,()=>globalThis.fetch(input, init)), value => ({ status: value.status }));
    } catch (error) {
      rpcStats.networkErrors += 1;
      const aborted =
        init?.signal?.aborted === true ||
        (error instanceof Error && error.name === "AbortError");
      if (aborted || attemptNetwork >= maxNetworkRetries) {
        rpcStats.finalNetworkErrors += 1;
        throw error;
      }

      rpcStats.retriesNetwork += 1;
      const delayMs = Math.min(
        networkMaxDelayMs,
        networkBaseDelayMs * 2 ** attemptNetwork,
      );
      if (debug) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[slrd:rpc] network retry ${attemptNetwork + 1}/${maxNetworkRetries} after ${delayMs}ms: ${message}\n`,
        );
      }
      attemptNetwork += 1;
      markSolardRpcQueued();
      await sleep(delayMs);
      continue;
    }

    rpcStats.responses += 1;
    if (response.status === 429) rpcStats.rateLimited429 += 1;

    if (response.status !== 429 || attempt429 >= max429Retries) {
      if (!response.ok) rpcStats.finalHttpErrors += 1;
      return response;
    }

    rpcStats.retries429 += 1;
    const exponential = Math.min(
      max429DelayMs,
      base429DelayMs * 2 ** attempt429,
    );
    const delayMs = retryAfterMs(response, exponential);

    if (debug) {
      process.stderr.write(
        `[slrd:rpc] 429 retry ${attempt429 + 1}/${max429Retries} after ${delayMs}ms\n`,
      );
    }

    attempt429 += 1;
    markSolardRpcQueued();
    await sleep(delayMs);
  }
}

/** web3.js fetch adapter using the standard Solard retry policy. */
function controlledRpcFetch(): FetchFn {
  return ((input, init) =>
    solardRpcFetch(input as RequestInfo | URL, init)) as FetchFn;
}

export type SolardConnectionOptions = {
  rpc?: RpcPacingOptions | RpcPacer;
  fetch?: FetchFn;
  /** Ordered fallbacks on the same cluster. Include a public endpoint last if desired. */
  rpcUrls?: readonly string[];
};

import { classifyEndpointResponse, DEAD_RECHECK_MS, endpointDead, markEndpointDead, rateCooldownMs, type EndpointFailure } from "./endpoint-health.ts";

async function endpointUnavailable(response: Response): Promise<boolean> {
  if ([401, 403, 429].includes(response.status) || response.status >= 500)
    return true;
  try {
    const payload = (await response.clone().json()) as {
      error?: { message?: string };
    };
    return (
      typeof payload.error?.message === "string" &&
      /max(?:imum)? usage reached|quota|rate limit|unauthori[sz]ed|forbidden|invalid api.?key|api.?key.*(?:expired|disabled|invalid)/i.test(
        payload.error.message,
      )
    );
  } catch {
    return false;
  }
}

/** Sticky provider-aware failover. Never retry ambiguous signed submissions. */
export class SolardRpcEndpointPool {
  readonly urls: readonly string[];
  private active = 0;
  private readonly statusRows: Array<{ endpoint: string; cooldownUntil: number; errors: number; lastReason: string | null }>;
  private readonly ready = new Map<number, number>();
  private readonly verifying = new Map<number, Promise<void>>();
  constructor(urls: readonly string[],private readonly transport?:FetchFn) {
    this.urls = [...new Set(urls)];
    if (!this.urls.length) throw new MissingConfigError("rpcUrls");
    for (const url of this.urls) {
      if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("RPC requires HTTP(S)");
    }
    this.statusRows = this.urls.map(url => ({ endpoint: rpcSafeEndpoint(url), cooldownUntil: 0, errors: 0, lastReason: null }));
  }
  get activeRpcUrl() { return this.urls[this.active]!; }
  status() { return this.statusRows.map((row,index) => ({ ...row, active: index === this.active,
    group: providerBudget(this.urls[index]!).group })); }
  private failure(index: number, reason: string, delay = 0, kind: EndpointFailure = "server") {
    const row = this.statusRows[index]!; row.errors++; row.lastReason = reason;
    if (kind === "exhausted" || kind === "auth") {
      // Credits gone or key rejected: skip it in every process, recheck later.
      markEndpointDead(this.urls[index]!, kind, row.endpoint, reason);
      row.cooldownUntil = Date.now() + DEAD_RECHECK_MS;
    } else if (kind === "rate") row.cooldownUntil = Date.now() + rateCooldownMs(row.errors, delay);
    else row.cooldownUntil = Date.now() + Math.max(delay, Math.min(120_000, 2000 * 2 ** Math.min(6,row.errors-1)));
    // The last live key is never benched for long: callers wait out a short pause instead of failing.
    const others = this.urls.some((url, i) => i !== index && !endpointDead(url));
    if (!others && kind !== "exhausted" && kind !== "auth")
      row.cooldownUntil = Math.min(row.cooldownUntil, Date.now() + Math.max(delay, 2_000));
    if (kind === "server" && row.errors <= 3 || row.errors % 20 === 0)
      console.warn(`[slrd:rpc-pool] ${row.endpoint} ${reason} (${kind}); cooldown ${row.cooldownUntil - Date.now()}ms`);
  }
  private async readiness(index: number, deadline: number, signal?: AbortSignal | null): Promise<void> {
    if (process.env.SLRD_RPC_VERIFY_MAINNET !== "1" || (this.ready.get(index) ?? 0) > Date.now()) return;
    const existing = this.verifying.get(index);
    if (existing) {
      // Shared verification cannot escape caller cancellation or deadline.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, deadline-Date.now()));
      const cancel = () => controller.abort(); signal?.addEventListener("abort", cancel, { once: true });
      try {
        if (signal?.aborted) throw new DOMException("RPC cancelled", "AbortError");
        await Promise.race([existing, new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(Object.assign(
            new Error("RPC readiness deadline/cancellation"), { name: signal?.aborted ? "AbortError" : "Error" })), { once: true });
        })]);
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
      return;
    }
    const verification = this.performReadiness(index, deadline, signal);
    this.verifying.set(index, verification);
    try { await verification; }
    finally { if (this.verifying.get(index) === verification) this.verifying.delete(index); }
  }
  private async performReadiness(index: number, deadline: number, signal?: AbortSignal | null): Promise<void> {
    const endpoint = this.urls[index]!;
    for (const method of ["getGenesisHash", "getBalance", "getAccountInfo"]) {
      const controller = new AbortController();
      const onAbort = () => controller.abort(); signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(3500,deadline-Date.now())));
      try {
        const body = JSON.stringify({ jsonrpc: "2.0", id: 31, method, params: method === "getGenesisHash" ? [] :
          method === "getBalance" ? [READINESS_ADDRESS] : [READINESS_ADDRESS, { encoding: "base64" }] });
        if (signal?.aborted) controller.abort();
        const permit = await sharedRpcScheduler.acquire(endpoint, 1, 0, controller.signal, deadline);
        let response: Response;
        try {
          response = await solardRpcFetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
          body, signal: controller.signal }, { poolScheduled: true, retryNetwork: false, retry429: false,fetch:this.transport });
        } finally { permit.release(); }
        if (!response.ok) throw new Error(`RPC readiness HTTP ${response.status}`);
        const result = await response.json() as { error?: unknown; result?: any };
        if (result.error) throw new Error("RPC account-read readiness rejected");
        if (method === "getGenesisHash" && result.result !== MAINNET_GENESIS) throw new Error("RPC_WRONG_CLUSTER");
        if (method === "getBalance" && (!Number.isFinite(result.result?.value) || !Number.isFinite(result.result?.context?.slot)))
          throw new Error("RPC balance read malformed");
        if (method === "getAccountInfo" && !Number.isFinite(result.result?.context?.slot))
          throw new Error("RPC account read malformed");
      } catch (error) {
        if (controller.signal.aborted && !signal?.aborted)
          throw Object.assign(new Error("RPC readiness timeout"), { code: "RPC_PROVIDER_UNAVAILABLE" });
        throw error;
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
    }
    this.ready.set(index, Date.now() + 60_000);
  }
  private batchParts(body: string): Array<string> | null {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return null; }
    if (!Array.isArray(parsed)) return null;
    const limit = Math.min(...this.urls.map(url => providerBudget(url).rps),
      Number(process.env.SLRD_RPC_AGGREGATE_RPS || Number.MAX_SAFE_INTEGER));
    const parts: string[] = []; let chunk: unknown[] = [], sends = 0;
    for (const row of parsed) {
      const send = (row as { method?: string })?.method === "sendTransaction";
      if (chunk.length >= limit || (send && (sends || chunk.length))) {
        parts.push(JSON.stringify(chunk)); chunk = []; sends = 0;
      }
      if (send && chunk.length) { parts.push(JSON.stringify(chunk)); chunk = []; }
      chunk.push(row); if (send) { parts.push(JSON.stringify(chunk)); chunk = []; sends = 0; }
    }
    if (chunk.length) parts.push(JSON.stringify(chunk));
    return parts.length > 1 ? parts : null;
  }
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const deadline = Date.now() + envInt("SLRD_RPC_QUEUE_TIMEOUT_MS", 15000, 100);
    return await traceSolardRpcRequest(input,init,()=>this.fetchWithin(input, init, deadline));
  }
  private async fetchWithin(_input: RequestInfo | URL, init: RequestInit | undefined,
    deadline: number): Promise<Response> {
    if (init?.signal?.aborted) throw new DOMException("RPC cancelled", "AbortError");
    if (Date.now() >= deadline)
      throw Object.assign(new Error("RPC_QUEUE_TIMEOUT"), { code: "RPC_QUEUE_TIMEOUT" });
    if (init?.body instanceof ReadableStream) throw new Error("RPC requires replayable body");
    if (typeof init?.body === "string") {
      const parts = this.batchParts(init.body);
      if (parts) {
        // Process in caller order; mixed signed/read batches never replay an
        // already attempted send. All JSON-RPC response IDs survive unchanged.
        const replies = new Map<unknown, unknown>();
        const original = JSON.parse(init.body) as Array<{ id?: unknown }>;
        for (const part of parts) {
          const response = await this.fetchWithin(_input, { ...init, body: part }, deadline);
          if (!response.ok) return response;
          const payload = await response.json() as unknown;
          if (!Array.isArray(payload)) throw new Error("RPC batch response expected array");
          for (const row of payload) {
            const id = (row as { id?: unknown }).id;
            if (replies.has(id)) throw new Error("Duplicate RPC batch id");
            replies.set(id,row);
          }
        }
        const ordered = original.map(row => {
          if (!replies.has(row.id)) throw new Error("Missing RPC batch id");
          return replies.get(row.id);
        });
        return new Response(JSON.stringify(ordered), { headers: { "content-type": "application/json" } });
      }
    }
    const signed = rpcRequestCost(init?.body).sends > 0;
    const visited = new Set<number>(); let lastError: unknown;
    while (visited.size < this.urls.length) {
      markSolardRpcQueued();
      const now = Date.now();
      const choices = [this.active, ...this.urls.map((_url,i) => i)]
        .filter((i, position, all) => all.indexOf(i) === position)
        .filter(i => !visited.has(i) && this.statusRows[i]!.cooldownUntil <= now && !endpointDead(this.urls[i]!, now));
      // A signed submission retains sticky single-endpoint semantics.
      // Reads prefer an available independent quota group rather than
      // enqueueing behind a saturated active provider.
      let index = choices[0];
      if (index === undefined) {
        // Only rate cooldowns left (no dead keys): wait for the soonest one instead of failing.
        const soonest = Math.min(...this.urls.map((url, i) => visited.has(i) || endpointDead(url, now)
          ? Infinity : this.statusRows[i]!.cooldownUntil));
        if (Number.isFinite(soonest) && soonest < deadline) {
          await new Promise(resolve => setTimeout(resolve, Math.max(1, soonest - Date.now())));
          if (init?.signal?.aborted) throw Object.assign(new Error("RPC request cancelled"), { name: "AbortError" });
          continue;
        }
        break;
      }
      let attempted = false;
      try {
        await this.readiness(index, deadline, init?.signal);
        const cost = rpcRequestCost(init?.body);
        let admission: Awaited<ReturnType<typeof sharedRpcScheduler.acquireAny>>;
        while (true) {
          admission = await measured(rpcMeasure, `${rpcMethod(init?.body)} provider queue`, async () => { await waitForRpcPriority(); return await sharedRpcScheduler.acquireAny(
            (signed ? [index] : choices).map(i => this.urls[i]!),
            cost.requests, cost.sends, init?.signal, deadline); }, () => undefined);
          index = this.urls.indexOf(admission.url);
          if (process.env.SLRD_RPC_VERIFY_MAINNET !== "1" || (this.ready.get(index) ?? 0) > Date.now()) break;
          // Cold backup: release its transport slot before metering its own probes.
          admission.permit.release();
          await this.readiness(index, deadline, init?.signal);
        }
        let response: Response;
        const controller = new AbortController();
        const abort = () => controller.abort();
        init?.signal?.addEventListener("abort", abort, { once: true });
        if (init?.signal?.aborted) controller.abort();
        const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
        try {
          attempted = true;
          response = await solardRpcFetch(this.urls[index]!, { ...init, signal: controller.signal },
            { poolScheduled: true, retry429: false, retryNetwork: false,fetch:this.transport });
        } catch (error) {
          if (controller.signal.aborted && !init?.signal?.aborted)
            throw Object.assign(new Error("RPC request deadline exceeded"), { code: "RPC_TIMEOUT", cause: error });
          throw error;
        } finally {
          clearTimeout(timer); init?.signal?.removeEventListener("abort", abort);
          admission.permit.release();
        }
        if (!(await endpointUnavailable(response))) {
          this.active = index; this.statusRows[index]!.errors = 0;
          this.statusRows[index]!.lastReason = null;
          return response;
        }
        visited.add(index);
        const kind = await classifyEndpointResponse(response);
        this.failure(index, `HTTP ${response.status} ${kind}`, retryAfterMs(response,0), kind === "ok" ? "server" : kind);
        if (signed) return response;
      } catch (error) {
        if (init?.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        if (signed && attempted) throw error;
        if (["RPC_QUEUE_FULL", "RPC_QUEUE_TIMEOUT", "RPC_TIMEOUT"].includes(String((error as {code?: string})?.code))) throw error;
        visited.add(index);
        this.failure(index, `Provider/network/queue failure: ${String((error as Error)?.message ?? error).slice(0, 120)}`); lastError = error;
      }
    }
    throw Object.assign(new Error("RPC_PROVIDER_UNAVAILABLE: no healthy RPC account-read endpoint"),
      { code: "RPC_PROVIDER_UNAVAILABLE", cause: lastError });
  }
}

export class SolardConnection {
  private value?: Connection;
  private pool?: SolardRpcEndpointPool;
  private readonly lifetime = new AbortController();
  private closed = false;

  constructor(
    private readonly rpcUrl?: string,
    private readonly commitment: Commitment = "confirmed",
    private readonly options: SolardConnectionOptions = {},
  ) {}

  get(): Connection {
    if (this.closed) throw new Error("Solard connection is closed");
    if (this.value) return this.value;

    const url =
      this.rpcUrl ?? this.options.rpcUrls?.[0] ?? process.env.RPC_ENDPOINT;
    if (!url) {
      throw new MissingConfigError("RPC_ENDPOINT or Solard({ rpcUrl })");
    }

    let environment: string[] = [];
    if (process.env.SLRD_RPC_URLS) {
      const parsed: unknown = JSON.parse(process.env.SLRD_RPC_URLS);
      if (!Array.isArray(parsed) || !parsed.every(value => typeof value === "string"))
        throw new Error("SLRD_RPC_URLS must be a JSON string array");
      environment = parsed as string[];
    }
    const candidates = this.options.rpcUrls?.length ? this.options.rpcUrls : environment;
    const urls = candidates.length ? [url, ...candidates] : undefined;
    const paced=this.options.rpc||this.options.fetch?resolveRpcPacer(this.options.rpc,this.options.fetch).fetch:undefined;
    if (urls) this.pool = new SolardRpcEndpointPool(urls,paced);
    const underlying=this.pool?(this.pool.fetch.bind(this.pool) as FetchFn):paced ? ((input,init)=>solardRpcFetch(input,init,{fetch:paced,retry429:false})) as FetchFn : controlledRpcFetch();
    const transport = ((...[input, init]: Parameters<FetchFn>) => underlying(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, this.lifetime.signal]) : this.lifetime.signal,
    })) as FetchFn;
    this.value = new Connection(url, {
      commitment: this.commitment,
      disableRetryOnRateLimit: true,
      fetch: transport,
    });
    if(paced||this.pool)connectionTransports.set(this.value,transport);
    const rpc=this.value as unknown as {_rpcRequest:(method:string,args:unknown[])=>Promise<unknown>;_rpcBatchRequest:(requests:Array<{methodName:string;args:unknown[]}>)=>Promise<unknown>};
    const request=rpc._rpcRequest.bind(rpc),batch=rpc._rpcBatchRequest.bind(rpc);
    rpc._rpcRequest=(method,args)=>traceSolardRpcOperation(this.activeRpcUrl??url,method,()=>request(method,args));
    rpc._rpcBatchRequest=requests=>traceSolardRpcOperation(this.activeRpcUrl??url,requests.map(r=>({method:r.methodName})),()=>batch(requests));
    return this.value;
  }
  /** Release only this owner's connection. web3.js has no public dispose API.
   * A rejected upgrade can leave rpc-websockets reconnecting even after the
   * final subscription is removed, so closing the current socket alone fails.
   */
  close(): void {
    if (this.closed) return;
    measuredSync(rpcMeasure, "close connection", () => {
      this.closed = true;
      this.lifetime.abort();
      if (!this.value) return true;
      const connection = this.value as unknown as {
        _updateSubscriptions: () => Promise<void>;
        _rpcWebSocketHeartbeat: ReturnType<typeof setInterval> | null;
        _rpcWebSocketIdleTimeout: ReturnType<typeof setTimeout> | null;
        _rpcWebSocket: {
          removeAllListeners?: (event: string) => void;
          setAutoReconnect?: (enabled: boolean) => void;
          reconnect?: boolean;
          reconnect_timer_id?: ReturnType<typeof setTimeout>;
          close(code?: number): void;
        };
      };
      // Late close/open callbacks must not resubscribe a disposed connection.
      connection._updateSubscriptions = async () => {};
      if (connection._rpcWebSocketHeartbeat) clearInterval(connection._rpcWebSocketHeartbeat);
      if (connection._rpcWebSocketIdleTimeout) clearTimeout(connection._rpcWebSocketIdleTimeout);
      connection._rpcWebSocketHeartbeat = null;
      connection._rpcWebSocketIdleTimeout = null;
      const socket = connection._rpcWebSocket;
      socket.removeAllListeners?.("open");
      socket.setAutoReconnect?.(false);
      socket.reconnect = false;
      if (socket.reconnect_timer_id) clearTimeout(socket.reconnect_timer_id);
      socket.reconnect_timer_id = undefined;
      try { socket.close(1000); } catch { /* Already disconnected/connecting. */ }
      return true;
    }, () => ({ closed: true }));
  }
  /** HTTP failover does not replace web3.js's independently managed WebSocket URL. */
  get activeRpcUrl(): string | undefined {
    return (
      this.pool?.activeRpcUrl ??
      this.rpcUrl ??
      this.options.rpcUrls?.[0] ??
      process.env.RPC_ENDPOINT
    );
  }
}
