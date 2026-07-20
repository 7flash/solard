export type HeliusHistoryStatus = "succeeded" | "failed" | "any";
export type HeliusTransactionDetails = "signatures" | "full";

export type HeliusHistoryOptions = {
  rpcUrl: string;
  address: string;
  limit?: number;
  paginationToken?: string | null;
  transactionDetails?: HeliusTransactionDetails;
  sortOrder?: "asc" | "desc";
  commitment?: "confirmed" | "finalized";
  status?: HeliusHistoryStatus;
  includeTokenAccounts?: boolean;
  tokenMint?: string | null;
  direction?: "in" | "out" | "any";
  slotGte?: number | null;
  slotLt?: number | null;
  blockTimeGte?: number | null;
  blockTimeLt?: number | null;
};

export function resolvedHeliusRpcUrl(): string | null {
  const direct =
    process.env.HELIUS_RPC_URL?.trim() ||
    process.env.RPC_ENDPOINT?.trim() ||
    null;
  if (direct) return direct;
  const apiKey = process.env.HELIUS_API_KEY?.trim();
  return apiKey
    ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`
    : null;
}

export function redactRpcUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    for (const key of ["api-key", "api_key", "apikey", "key"]) {
      const value = parsed.searchParams.get(key);
      if (value)
        parsed.searchParams.set(key, `${value.slice(0, 4)}…${value.slice(-4)}`);
    }
    return parsed.toString();
  } catch {
    return url.replace(/(api-key=)[^&]+/i, "$1****");
  }
}

export function rpcHasApiKey(url: string | null | undefined): boolean {
  if (!url) return false;
  if (process.env.HELIUS_API_KEY?.trim()) return true;
  try {
    const parsed = new URL(url);
    return Boolean(
      parsed.searchParams.get("api-key") ||
      parsed.searchParams.get("api_key") ||
      parsed.searchParams.get("apikey") ||
      parsed.searchParams.get("key"),
    );
  } catch {
    return /api[-_]?key=|apikey=|key=/i.test(url);
  }
}

function numberFilter(
  gte?: number | null,
  lt?: number | null,
): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  if (typeof gte === "number" && Number.isFinite(gte)) out.gte = gte;
  if (typeof lt === "number" && Number.isFinite(lt)) out.lt = lt;
  return Object.keys(out).length ? out : undefined;
}

export async function getTransactionsForAddress(
  options: HeliusHistoryOptions,
): Promise<unknown> {
  const filters: Record<string, unknown> = {};
  filters.status = options.status ?? "succeeded";
  if (options.includeTokenAccounts) filters.tokenAccounts = "all";
  const slot = numberFilter(options.slotGte, options.slotLt);
  if (slot) filters.slot = slot;
  const blockTime = numberFilter(options.blockTimeGte, options.blockTimeLt);
  if (blockTime) filters.blockTime = blockTime;
  if (options.tokenMint || options.direction) {
    filters.tokenTransfer = {
      ...(options.tokenMint ? { mint: options.tokenMint } : {}),
      direction: options.direction ?? "any",
    };
  }

  const params = [
    options.address,
    {
      transactionDetails: options.transactionDetails ?? "signatures",
      sortOrder: options.sortOrder ?? "desc",
      commitment: options.commitment ?? "finalized",
      limit: Math.max(1, Math.min(1000, options.limit ?? 100)),
      ...(options.paginationToken
        ? { paginationToken: options.paginationToken }
        : {}),
      ...(Object.keys(filters).length ? { filters } : {}),
      ...(options.transactionDetails === "full"
        ? { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }
        : {}),
    },
  ];

  const response = await fetch(options.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "getTransactionsForAddress",
      params,
    }),
  });
  const payload = (await response.json().catch(() => null)) as {
    result?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok || payload?.error) {
    throw new Error(
      `getTransactionsForAddress failed HTTP ${response.status}: ${JSON.stringify(payload?.error ?? payload ?? {})}`,
    );
  }
  return payload?.result ?? null;
}
