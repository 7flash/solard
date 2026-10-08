import { Connection, type Commitment, type FetchFn } from "@solana/web3.js";

import { MissingConfigError } from "../core/errors.ts";
import { SharedRpcWindow, rpcRequestCost } from "./shared-rpc-window.ts";

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
 * request budget. SLRD_RPC_GATE_DB shares atomic reservations between processes
 * configured with the same window limits. Network calls never hold SQLite locks.
 */
const rpcWindows = new Map<string, SharedRpcWindow>();

async function acquireRpcSlot(maxRps: number, body?: unknown): Promise<void> {
  const path = process.env.SLRD_RPC_GATE_DB ?? "";
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
  /** Disable transport-level 429 retries when the caller owns retry/backoff. */
  retry429?: boolean;
  /** Disable retries for fetch-level transport failures such as ECONNRESET. */
  retryNetwork?: boolean;
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
  const maxRps = envInt("SLRD_RPC_MAX_RPS", 5, 1);
  const max429Retries =
    options.retry429 === false ? 0 : envInt("SLRD_RPC_429_RETRIES", 6, 0);
  const base429DelayMs = envInt("SLRD_RPC_429_BASE_DELAY_MS", 500, 1);
  const max429DelayMs = envInt("SLRD_RPC_429_MAX_DELAY_MS", 8_000, 1);
  const maxNetworkRetries =
    options.retryNetwork === false
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
    await acquireRpcSlot(maxRps, init?.body);

    let response: Response;
    try {
      response = await globalThis.fetch(input, init);
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
    await sleep(delayMs);
  }
}

/** web3.js fetch adapter using the standard Solard retry policy. */
function controlledRpcFetch(): FetchFn {
  return ((input, init) =>
    solardRpcFetch(input as RequestInfo | URL, init)) as FetchFn;
}

export type SolardConnectionOptions = {
  /** Ordered fallbacks on the same cluster. Include a public endpoint last if desired. */
  rpcUrls?: readonly string[];
};

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

/** Sticky HTTP failover; every attempt repeats the identical JSON-RPC body. */
export class SolardRpcEndpointPool {
  readonly urls: readonly string[];
  private active = 0;
  constructor(urls: readonly string[]) {
    this.urls = [...new Set(urls)];
    if (!this.urls.length) throw new MissingConfigError("rpcUrls");
    for (const value of this.urls) {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("RPC endpoints require HTTP or HTTPS");
    }
  }
  get activeRpcUrl(): string {
    return this.urls[this.active]!;
  }
  async fetch(
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // JSON-RPC bodies are strings. A stream cannot be replayed safely.
    if (init?.body instanceof ReadableStream)
      throw new Error(
        "RPC endpoint failover requires a replayable request body",
      );
    const visited = new Set<number>();
    let lastResponse: Response | undefined;
    let lastError: unknown;
    while (visited.size < this.urls.length) {
      let index = this.active;
      if (visited.has(index))
        index = this.urls.findIndex(
          (_url, candidate) => !visited.has(candidate),
        );
      visited.add(index);
      try {
        const response = await solardRpcFetch(this.urls[index]!, init, {
          retry429: false,
          retryNetwork: false,
        });
        if (!(await endpointUnavailable(response))) return response;
        lastResponse = response;
      } catch (error) {
        if (
          init?.signal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
        )
          throw error;
        lastError = error;
      }
      if (this.active === index) this.active = (index + 1) % this.urls.length;
    }
    if (lastResponse) return lastResponse;
    throw lastError ?? new Error("No RPC endpoint is available");
  }
}

export class SolardConnection {
  private value?: Connection;
  private pool?: SolardRpcEndpointPool;

  constructor(
    private readonly rpcUrl?: string,
    private readonly commitment: Commitment = "confirmed",
    private readonly options: SolardConnectionOptions = {},
  ) {}

  get(): Connection {
    if (this.value) return this.value;

    const url =
      this.rpcUrl ?? this.options.rpcUrls?.[0] ?? process.env.RPC_ENDPOINT;
    if (!url) {
      throw new MissingConfigError("RPC_ENDPOINT or Solard({ rpcUrl })");
    }

    const urls = this.options.rpcUrls?.length
      ? [url, ...this.options.rpcUrls]
      : undefined;
    if (urls) this.pool = new SolardRpcEndpointPool(urls);
    this.value = new Connection(url, {
      commitment: this.commitment,
      disableRetryOnRateLimit: true,
      fetch: this.pool
        ? (this.pool.fetch.bind(this.pool) as FetchFn)
        : controlledRpcFetch(),
    });
    return this.value;
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
