import { indexerMeasure, summarizeError, summarizeValue } from "./measure.js";

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

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
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
  const staticValue = Number(
    process.env.SOLARD_SOL_USD ?? input.fallback ?? "",
  );

  if (Number.isFinite(staticValue) && staticValue > 0) {
    state.value = staticValue;
    state.updatedAtMs = Date.now();
    state.source = "env";
    state.error = null;
    return solUsdState();
  }

  const now = Date.now();
  if (
    !input.force &&
    state.value != null &&
    state.updatedAtMs != null &&
    now - state.updatedAtMs < (input.maxAgeMs ?? 30_000)
  ) {
    return solUsdState();
  }

  return await indexerMeasure.measure(
    {
      start: () => "sol_usd:refresh",
      end: summarizeValue,
      catch: summarizeError,
    },
    async () => {
      const timeout = input.timeoutMs ?? 2_500;
      const errors: string[] = [];

      try {
        const data = await fetchJson(
          `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`,
          timeout,
        );
        const value = Number(
          data?.[SOL_MINT]?.usdPrice ?? data?.[SOL_MINT]?.price,
        );
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error("missing SOL price");
        }
        state.value = value;
        state.updatedAtMs = Date.now();
        state.source = "jupiter";
        state.error = null;
        return solUsdState();
      } catch (error) {
        errors.push(
          `jupiter: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      try {
        const data = await fetchJson(
          "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
          timeout,
        );
        const value = Number(data?.solana?.usd);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error("missing SOL price");
        }
        state.value = value;
        state.updatedAtMs = Date.now();
        state.source = "coingecko";
        state.error = null;
        return solUsdState();
      } catch (error) {
        errors.push(
          `coingecko: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      state.error = errors.join("; ");
      if (state.value != null) return solUsdState();
      throw new Error(state.error);
    },
  );
}
