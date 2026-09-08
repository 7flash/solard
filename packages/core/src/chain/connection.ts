import { Connection, type Commitment, type FetchFn } from "@solana/web3.js";

import { MissingConfigError } from "../core/errors.ts";

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
 * One process-wide JSON-RPC start-rate gate.
 *
 * A provider limit of 5 RPS means every caller in the process shares the same
 * five-request budget. Per-feature concurrency limits are not sufficient.
 */
let rpcGateTail: Promise<void> = Promise.resolve();
let rpcNextStartAtMs = 0;

async function acquireRpcSlot(maxRps: number): Promise<void> {
  const safeRps = Math.max(1, maxRps);
  const spacingMs = Math.ceil(1000 / safeRps) + 5;

  let release!: () => void;
  const previous = rpcGateTail;
  rpcGateTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    const now = Date.now();
    const delayMs = Math.max(0, rpcNextStartAtMs - now);
    if (delayMs > 0) {
      rpcStats.gateWaitMs += delayMs;
      await sleep(delayMs);
    }

    const startedAt = Date.now();
    rpcNextStartAtMs = Math.max(rpcNextStartAtMs, startedAt) + spacingMs;
    rpcStats.requestStarts += 1;
  } finally {
    release();
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
    await acquireRpcSlot(maxRps);

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

export class SolardConnection {
  private value?: Connection;

  constructor(
    private readonly rpcUrl?: string,
    private readonly commitment: Commitment = "confirmed",
  ) {}

  get(): Connection {
    if (this.value) return this.value;

    const url = this.rpcUrl ?? process.env.RPC_ENDPOINT;
    if (!url) {
      throw new MissingConfigError("RPC_ENDPOINT or Solard({ rpcUrl })");
    }

    this.value = new Connection(url, {
      commitment: this.commitment,
      disableRetryOnRateLimit: true,
      fetch: controlledRpcFetch(),
    });
    return this.value;
  }
}
