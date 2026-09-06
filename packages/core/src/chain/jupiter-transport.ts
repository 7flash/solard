import { createSolardMeasure } from "../core/log.ts";
import { short } from "../core/log-result.ts";
import { measured } from "../core/measured.ts";
import { JupiterHttpError } from "./jupiter-errors.ts";
import type {
  JupiterSwapExecuteResult,
  JupiterSwapOrder,
} from "./jupiter-swap-types.ts";

const BASE_URL = "https://api.jup.ag/swap/v2";
const m = createSolardMeasure("jupiter");

type JupiterHttpKind = "order" | "execute";
type JupiterEndpoint = "/order" | "/execute";

type JupiterHttpResult = {
  response: Response;
  attempts: number;
  rateLimited: number;
  retryDelayMs: number;
};

export type JupiterOrderRequest = {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  taker?: string;
};

export type JupiterExecuteRequest = {
  signedTransaction: string;
  requestId: string;
};

export type JupiterTransport = {
  fetchOrder(args: JupiterOrderRequest): Promise<JupiterSwapOrder>;
  executeSignedTransaction(
    args: JupiterExecuteRequest,
  ): Promise<JupiterSwapExecuteResult>;
};

export type JupiterTransportDependencies = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  env?: (name: string) => string | undefined;
};

function safeApiErrorDetail(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as {
      errorMessage?: unknown;
      error?: unknown;
      message?: unknown;
    };
    const candidate = parsed.errorMessage ?? parsed.error ?? parsed.message;
    if (typeof candidate !== "string") return undefined;
    const detail = candidate.replace(/[\r\n\t]+/g, " ").trim();
    return detail ? detail.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

function orderPath(args: JupiterOrderRequest): string {
  const query = new URLSearchParams({
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: args.amountRaw.toString(),
  });
  if (args.taker) query.set("taker", args.taker);
  return `/order?${query}`;
}

export function createJupiterTransport(
  dependencies: JupiterTransportDependencies = {},
): JupiterTransport {
  const fetchImpl = dependencies.fetch ?? fetch;
  const sleep =
    dependencies.sleep ??
    ((ms: number) =>
      ms > 0
        ? new Promise<void>((resolve) => setTimeout(resolve, ms))
        : Promise.resolve());
  const now = dependencies.now ?? Date.now;
  const env = dependencies.env ?? ((name: string) => process.env[name]);

  let apiTail: Promise<void> = Promise.resolve();
  let apiNextStartAtMs = 0;

  function envNumber(name: string, fallback: number, minimum: number): number {
    const raw = env(name);
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
  }

  function apiKey(): string {
    const key = env("JUPITER_API_KEY")?.trim();
    if (!key) {
      throw new Error(
        "Jupiter Swap V2 requires JUPITER_API_KEY. Set JUPITER_API_KEY in your environment before using Jupiter swaps.",
      );
    }
    return key;
  }

  async function acquireSlot(): Promise<void> {
    await measured(
      m,
      "rate-limit",
      async () => {
        const maxRps = envNumber("SLRD_JUPITER_MAX_RPS", 1, 0.1);
        const spacingMs = Math.ceil(1000 / maxRps) + 10;

        let release!: () => void;
        const previous = apiTail;
        apiTail = new Promise<void>((resolve) => {
          release = resolve;
        });

        await previous;
        let waitMs = 0;
        try {
          waitMs = Math.max(0, apiNextStartAtMs - now());
          if (waitMs > 0) await sleep(waitMs);
          apiNextStartAtMs = now() + spacingMs;
        } finally {
          release();
        }

        return { waitMs, maxRps };
      },
      (result) => result,
    );
  }

  async function request(
    kind: JupiterHttpKind,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const result = await measured(
      m,
      `http ${kind}`,
      async (): Promise<JupiterHttpResult> => {
        const key = apiKey();
        const maxRetries = Math.trunc(
          envNumber("SLRD_JUPITER_429_RETRIES", 4, 0),
        );
        let retries = 0;
        let rateLimited = 0;
        let retryDelayMs = 0;

        while (true) {
          await acquireSlot();

          const headers = new Headers(init.headers);
          headers.set("x-api-key", key);

          const response = await fetchImpl(`${BASE_URL}${path}`, {
            ...init,
            headers,
          });

          if (response.status !== 429 || retries >= maxRetries) {
            return {
              response,
              attempts: retries + 1,
              rateLimited,
              retryDelayMs,
            };
          }

          rateLimited += 1;
          void response.body?.cancel().catch(() => {});
          const retryAfter = Number(response.headers.get("retry-after") ?? "");
          const delayMs =
            Number.isFinite(retryAfter) && retryAfter >= 0
              ? Math.max(500, Math.ceil(retryAfter * 1000))
              : Math.min(8_000, 500 * 2 ** retries);

          retries += 1;
          retryDelayMs += delayMs;
          await sleep(delayMs);
        }
      },
      (transport) => ({
        status: transport.response.status,
        ok: transport.response.ok,
        attempts: transport.attempts,
        rateLimited: transport.rateLimited,
        retryDelayMs: transport.retryDelayMs,
      }),
    );

    return result.response;
  }

  async function readJson<T>(
    response: Response,
    endpoint: JupiterEndpoint,
  ): Promise<T> {
    const body = await response.text();
    if (!response.ok) {
      throw new JupiterHttpError(
        endpoint,
        response.status,
        safeApiErrorDetail(body),
      );
    }
    try {
      return JSON.parse(body) as T;
    } catch (error) {
      throw new Error(`Jupiter ${endpoint} returned invalid JSON`, {
        cause: error,
      });
    }
  }

  return {
    async fetchOrder(args) {
      return await measured(
        m,
        "order",
        async () =>
          await readJson<JupiterSwapOrder>(
            await request("order", orderPath(args), { method: "GET" }),
            "/order",
          ),
        (order) => ({
          inputMint: short(args.inputMint),
          outputMint: short(args.outputMint),
          amountRaw: args.amountRaw.toString(),
          taker: short(args.taker),
          router: order.router ?? null,
          mode: order.mode ?? null,
          outAmount: order.outAmount ?? null,
          hasTransaction: Boolean(order.transaction),
          errorCode: order.errorCode ?? null,
        }),
      );
    },

    async executeSignedTransaction(args) {
      return await readJson<JupiterSwapExecuteResult>(
        await request("execute", "/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            signedTransaction: args.signedTransaction,
            requestId: args.requestId,
          }),
        }),
        "/execute",
      );
    },
  };
}

const defaultTransport = createJupiterTransport();

export async function fetchJupiterOrder(
  args: JupiterOrderRequest,
): Promise<JupiterSwapOrder> {
  return await defaultTransport.fetchOrder(args);
}

export async function executeJupiterSignedTransaction(
  args: JupiterExecuteRequest,
): Promise<JupiterSwapExecuteResult> {
  return await defaultTransport.executeSignedTransaction(args);
}

export function defaultJupiterTransport(): JupiterTransport {
  return defaultTransport;
}
