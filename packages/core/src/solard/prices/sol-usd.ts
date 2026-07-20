import { workerMeasure, summarizeForMeasure } from "../measure.ts";

let cached: {
  value: number | null;
  expiresAtMs: number;
  source: string;
  error?: string | null;
} = {
  value: null,
  expiresAtMs: 0,
  source: "none",
  error: null,
};

const SOL_MINT = "So11111111111111111111111111111111111111112";

function finitePositive(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function fromEnv(): { value: number; source: string } | null {
  for (const name of ["SOLARD_SOL_USD", "SOL_USD", "SOLARD_SOL_USD_FALLBACK"]) {
    const parsed = finitePositive(process.env[name]);
    if (parsed != null) return { value: parsed, source: name };
  }
  return null;
}

function parsePrice(payload: any): number | null {
  return (
    finitePositive(payload?.data?.SOL?.price) ??
    finitePositive(payload?.data?.[SOL_MINT]?.price) ??
    finitePositive(payload?.data?.[SOL_MINT]?.usdPrice) ??
    finitePositive(payload?.SOL?.price) ??
    finitePositive(payload?.[SOL_MINT]?.price) ??
    finitePositive(payload?.[SOL_MINT]?.usdPrice) ??
    finitePositive(payload?.price) ??
    finitePositive(payload?.data?.amount) ??
    finitePositive(payload?.data?.rates?.USD) ??
    finitePositive(payload?.rates?.USD)
  );
}

async function fetchJson(url: string, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return await res.json();
}

async function fetchSolUsd(
  signal: AbortSignal,
): Promise<{ value: number; source: string } | null> {
  const configured = process.env.SOLARD_SOL_USD_URL?.trim();
  const urls = configured
    ? [configured]
    : [
        `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`,
        "https://price.jup.ag/v6/price?ids=SOL",
        "https://api.coinbase.com/v2/exchange-rates?currency=SOL",
      ];

  let lastError: unknown = null;
  for (const url of urls) {
    try {
      const payload = await fetchJson(url, signal);
      const value = parsePrice(payload);
      if (value != null)
        return {
          value,
          source: url.includes("coinbase")
            ? "coinbase"
            : url.includes("jup")
              ? "jupiter"
              : "custom",
        };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

export async function resolveSolUsd(
  input: { maxAgeMs?: number; timeoutMs?: number } = {},
): Promise<number | null> {
  const now = Date.now();
  const maxAgeMs = Math.max(
    5_000,
    input.maxAgeMs ?? Number(process.env.SOLARD_SOL_USD_CACHE_MS ?? "30000"),
  );
  if (cached.value != null && cached.expiresAtMs > now) return cached.value;

  const env = fromEnv();
  if (env && process.env.SOLARD_SOL_USD_FORCE_FETCH !== "1") {
    cached = {
      value: env.value,
      expiresAtMs: now + maxAgeMs,
      source: env.source,
      error: null,
    };
    return env.value;
  }

  return await workerMeasure.measure(
    {
      start: () => "resolve SOL/USD",
      end: (result) => ({
        result: summarizeForMeasure({
          value: result,
          source: cached.source,
          error: cached.error ?? null,
        }),
      }),
      catch: (error) => {
        const fallback =
          env?.value ?? finitePositive(process.env.SOLARD_SOL_USD_FALLBACK);
        cached = {
          value: fallback,
          expiresAtMs: Date.now() + Math.min(maxAgeMs, 10_000),
          source: fallback == null ? "none" : (env?.source ?? "fallback"),
          error: error instanceof Error ? error.message : String(error),
        };
        return fallback;
      },
    },
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(
          500,
          input.timeoutMs ??
            Number(process.env.SOLARD_SOL_USD_TIMEOUT_MS ?? "2000"),
        ),
      );
      try {
        const resolved = await fetchSolUsd(controller.signal);
        cached = {
          value: resolved?.value ?? env?.value ?? null,
          expiresAtMs: Date.now() + maxAgeMs,
          source: resolved?.source ?? env?.source ?? "none",
          error: null,
        };
        return cached.value;
      } finally {
        clearTimeout(timer);
      }
    },
  );
}

export function solUsdCacheState(): Record<string, unknown> {
  return {
    ...cached,
    expiresInMs: Math.max(0, cached.expiresAtMs - Date.now()),
  };
}
