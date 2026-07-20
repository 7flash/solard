import { indexerMeasure, summarizeError, summarizeValue } from "./measure.ts";

const SOL_MINT = "So11111111111111111111111111111111111111112";

export type SolUsdState = {
  value: number | null;
  updatedAtMs: number | null;
  source: string | null;
  error: string | null;
};

const state: SolUsdState = {
  value: null,
  updatedAtMs: null,
  source: null,
  error: null,
};

function configuredStaticPrice(): number | null {
  const parsed = Number(process.env.SOLARD_SOL_USD ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromJupiter(timeoutMs: number): Promise<number> {
  const data = await fetchJson<any>(
    `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`,
    timeoutMs,
  );
  const price = Number(data?.[SOL_MINT]?.usdPrice ?? data?.[SOL_MINT]?.price);
  if (!Number.isFinite(price) || price <= 0)
    throw new Error("Jupiter response did not include SOL usdPrice");
  return price;
}

async function fetchFromCoingecko(timeoutMs: number): Promise<number> {
  const data = await fetchJson<any>(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
    timeoutMs,
  );
  const price = Number(data?.solana?.usd);
  if (!Number.isFinite(price) || price <= 0)
    throw new Error("CoinGecko response did not include solana.usd");
  return price;
}

export function solUsdState(): SolUsdState {
  return { ...state };
}

export async function refreshSolUsd(
  input: {
    fallback?: number | null;
    timeoutMs?: number;
    force?: boolean;
    maxAgeMs?: number;
  } = {},
): Promise<SolUsdState> {
  const timeoutMs = input.timeoutMs ?? 2500;
  const maxAgeMs = input.maxAgeMs ?? 30_000;
  const now = Date.now();

  const staticPrice = configuredStaticPrice() ?? input.fallback ?? null;
  if (staticPrice != null) {
    state.value = staticPrice;
    state.updatedAtMs = now;
    state.source = "env";
    state.error = null;
    return solUsdState();
  }

  if (
    !input.force &&
    state.value != null &&
    state.updatedAtMs != null &&
    now - state.updatedAtMs < maxAgeMs
  ) {
    return solUsdState();
  }

  return await indexerMeasure.measure(
    {
      start: () => "sol_usd:refresh",
      end: (value) => summarizeValue(value),
      catch: summarizeError,
    },
    async () => {
      const providers: Array<[string, () => Promise<number>]> = [
        ["jupiter", () => fetchFromJupiter(timeoutMs)],
        ["coingecko", () => fetchFromCoingecko(timeoutMs)],
      ];

      const errors: string[] = [];
      for (const [source, fn] of providers) {
        try {
          const price = await fn();
          state.value = price;
          state.updatedAtMs = Date.now();
          state.source = source;
          state.error = null;
          return solUsdState();
        } catch (error) {
          errors.push(
            `${source}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      state.error = errors.join("; ");
      if (state.value != null) return solUsdState();
      throw new Error(state.error || "Failed to refresh SOL/USD");
    },
  );
}
