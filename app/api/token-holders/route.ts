import { assertWebAuth } from "../../../src/web/http.js";
import { withMeasuredApi } from "../../../src/solard/api-response.js";

function rpcUrl(): string {
  const explicit =
    process.env.HELIUS_RPC_URL?.trim() ||
    process.env.RPC_ENDPOINT?.trim() ||
    process.env.SOLANA_RPC_URL?.trim();
  if (explicit) return explicit;
  const key = process.env.HELIUS_API_KEY?.trim();
  if (key)
    return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  return "https://api.mainnet-beta.solana.com";
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${Date.now()}:${method}`,
      method,
      params,
    }),
    signal: AbortSignal.timeout(
      Number(process.env.SOLARD_HOLDERS_RPC_TIMEOUT_MS ?? "7000"),
    ),
  });
  if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`);
  const payload = (await response.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (payload.error)
    throw new Error(payload.error.message || `RPC ${method} failed`);
  return payload.result as T;
}

function pct(
  amount: string | null | undefined,
  supply: string | null | undefined,
): number | null {
  try {
    const a = BigInt(amount || "0");
    const s = BigInt(supply || "0");
    if (s <= 0n) return null;
    return Number((a * 1_000_000n) / s) / 10_000;
  } catch {
    const an = Number(amount ?? 0);
    const sn = Number(supply ?? 0);
    return Number.isFinite(an) && Number.isFinite(sn) && sn > 0
      ? (an / sn) * 100
      : null;
  }
}

export function GET(request: Request): Promise<Response> {
  return withMeasuredApi({
    request,
    route: "/api/token-holders",
    method: "GET",
    label: "token holders",
    summarize: (value: any) => ({
      mint: value?.mint,
      holders: value?.holders?.length ?? 0,
      ok: value?.ok,
    }),
    fn: async () => {
      assertWebAuth(request);
      const url = new URL(request.url);
      const mint = (url.searchParams.get("mint") ?? "").trim();
      const limit = Math.max(
        1,
        Math.min(Number(url.searchParams.get("limit") ?? "12"), 20),
      );
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
        return {
          ok: false,
          mint,
          holders: [],
          unavailableReason: "invalid token mint",
        };
      }
      try {
        const largest = await rpc<{
          value: Array<{
            address: string;
            amount: string;
            decimals: number;
            uiAmount?: number | null;
            uiAmountString?: string;
          }>;
        }>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
        const supply = await rpc<{
          value: {
            amount: string;
            decimals: number;
            uiAmount?: number | null;
            uiAmountString?: string;
          };
        }>("getTokenSupply", [mint, { commitment: "confirmed" }]);
        const accounts = (largest.value ?? []).slice(0, limit);
        const owners = accounts.length
          ? await rpc<{
              value: Array<{
                data?: { parsed?: { info?: { owner?: string } } } | null;
              }>;
            }>("getMultipleAccounts", [
              accounts.map((row) => row.address),
              { commitment: "confirmed", encoding: "jsonParsed" },
            ]).catch(() => ({ value: [] }))
          : { value: [] };
        const holders = accounts.map((row, index) => {
          const owner =
            owners.value?.[index]?.data?.parsed?.info?.owner ?? null;
          return {
            tokenAccount: row.address,
            owner,
            amount: row.amount,
            uiAmount:
              row.uiAmountString ??
              (row.uiAmount != null ? String(row.uiAmount) : null),
            decimals: row.decimals,
            pctSupply: pct(row.amount, supply.value?.amount) ?? null,
            label: index === 0 ? "largest" : null,
            source: "rpc:getTokenLargestAccounts",
          };
        });
        return { ok: true, mint, supply: supply.value, holders };
      } catch (error) {
        return {
          ok: false,
          mint,
          holders: [],
          unavailableReason:
            error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
