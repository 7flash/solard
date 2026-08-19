import { Connection, type Commitment, type FetchFn } from "@solana/web3.js";

import { MissingConfigError } from "../core/errors.ts";

export type SolardRpcStats = {
  maxRps: number;
  requestStarts: number;
  responses: number;
  rateLimited429: number;
  retries429: number;
  finalHttpErrors: number;
  gateWaitMs: number;
};

const rpcStats: SolardRpcStats = {
  maxRps: 5,
  requestStarts: 0,
  responses: 0,
  rateLimited429: 0,
  retries429: 0,
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

/**
 * Globally rate-limited and quiet web3.js transport.
 *
 * Retries re-enter acquireRpcSlot(), so a 429 retry never bypasses the process
 * RPS ceiling.
 */
function controlledRpcFetch(): FetchFn {
  const maxRps = envInt("SLRD_RPC_MAX_RPS", 5, 1);
  const maxRetries = envInt("SLRD_RPC_429_RETRIES", 6, 0);
  const baseDelayMs = envInt("SLRD_RPC_429_BASE_DELAY_MS", 500, 1);
  const maxDelayMs = envInt("SLRD_RPC_429_MAX_DELAY_MS", 8_000, 1);
  const debug =
    process.env.SLRD_RPC_RETRY_LOG === "1" ||
    process.env.SLRD_RPC_RETRY_LOG === "true";

  rpcStats.maxRps = maxRps;

  return (async (input, init) => {
    let attempt = 0;

    while (true) {
      await acquireRpcSlot(maxRps);
      const response = await globalThis.fetch(input as RequestInfo | URL, init);
      rpcStats.responses += 1;

      if (response.status === 429) {
        rpcStats.rateLimited429 += 1;
      }

      if (response.status !== 429 || attempt >= maxRetries) {
        if (!response.ok) rpcStats.finalHttpErrors += 1;
        return response;
      }

      rpcStats.retries429 += 1;
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delayMs = retryAfterMs(response, exponential);

      if (debug) {
        process.stderr.write(
          `[slrd:rpc] 429 retry ${attempt + 1}/${maxRetries} after ${delayMs}ms\n`,
        );
      }

      attempt += 1;
      await sleep(delayMs);
    }
  }) as FetchFn;
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
