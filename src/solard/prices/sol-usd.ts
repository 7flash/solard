import { workerMeasure, summarizeForMeasure } from "../measure.js";

let cached: { value: number | null; expiresAtMs: number; source: string } = {
  value: null,
  expiresAtMs: 0,
  source: "none",
};

function fromEnv(): number | null {
  for (const name of ["SOLARD_SOL_USD", "SOL_USD", "SOLARD_SOL_USD_FALLBACK"]) {
    const parsed = Number(process.env[name] ?? "");
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

async function fetchJupiterPrice(signal?: AbortSignal): Promise<number | null> {
  const url =
    process.env.SOLARD_SOL_USD_URL || "https://price.jup.ag/v6/price?ids=SOL";
  const res = await fetch(url, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`SOL/USD quote failed: ${res.status}`);
  const payload = (await res.json()) as any;
  const direct = Number(
    payload?.data?.SOL?.price ?? payload?.SOL?.price ?? payload?.price,
  );
  return Number.isFinite(direct) && direct > 0 ? direct : null;
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
  if (env != null && process.env.SOLARD_SOL_USD_FORCE_FETCH !== "1") {
    cached = { value: env, expiresAtMs: now + maxAgeMs, source: "env" };
    return env;
  }

  return await workerMeasure.measure(
    {
      start: () => "resolve SOL/USD",
      end: (result) => ({
        result: summarizeForMeasure({ value: result, source: cached.source }),
      }),
      catch: () => {
        const fallback =
          env ??
          (Number.isFinite(Number(process.env.SOLARD_SOL_USD_FALLBACK))
            ? Number(process.env.SOLARD_SOL_USD_FALLBACK)
            : null);
        cached = {
          value: fallback,
          expiresAtMs: Date.now() + Math.min(maxAgeMs, 10_000),
          source: fallback == null ? "none" : "fallback",
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
            Number(process.env.SOLARD_SOL_USD_TIMEOUT_MS ?? "1500"),
        ),
      );
      try {
        const value = await fetchJupiterPrice(controller.signal);
        cached = {
          value: value ?? env,
          expiresAtMs: Date.now() + maxAgeMs,
          source: value == null ? "env" : "jupiter",
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
