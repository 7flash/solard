import { randomUUID } from "node:crypto";

export type GmgnChain =
  "sol" | "bsc" | "base" | "eth" | "robinhood" | "arc" | "stable";

export type GmgnQueryValue =
  string | number | boolean | string[] | number[] | undefined;
export type GmgnQuery = Record<string, GmgnQueryValue>;

const DEFAULT_GMGN_API = "https://openapi.gmgn.ai";

function timeoutMs(): number {
  const value = Number(
    process.env.SOLARD_EXTERNAL_HTTP_TIMEOUT_MS ??
      process.env.SLRD_EXTERNAL_HTTP_TIMEOUT_MS ??
      "10000",
  );
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 10_000;
}

function appendQuery(url: URL, query: GmgnQuery): void {
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) url.searchParams.append(key, String(entry));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

function rateLimitReset(response: Response, payload: any): number | null {
  const fromBody = Number(payload?.reset_at ?? payload?.data?.reset_at);
  if (Number.isFinite(fromBody) && fromBody > 0) return fromBody;
  const fromHeader = Number(response.headers.get("x-ratelimit-reset"));
  return Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : null;
}

/**
 * Read-only GMGN OpenAPI client.
 *
 * This intentionally implements only "exist auth" endpoints. It never reads a
 * GMGN private key and cannot submit swaps/orders. Solard remains the only
 * transaction execution boundary.
 */
export class GmgnReadService {
  private baseUrl(): string {
    return (process.env.GMGN_API_URL?.trim() || DEFAULT_GMGN_API).replace(
      /\/+$/,
      "",
    );
  }

  configured(): boolean {
    return Boolean(process.env.GMGN_API_KEY?.trim());
  }

  private apiKey(): string {
    const key = process.env.GMGN_API_KEY?.trim();
    if (!key) {
      throw new Error(
        "GMGN read tools require GMGN_API_KEY. No GMGN private key is used or supported by this client.",
      );
    }
    return key;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    query: GmgnQuery = {},
    body?: unknown,
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl()}${path}`);
    appendQuery(url, {
      ...query,
      timestamp: Math.floor(Date.now() / 1000),
      client_id: randomUUID(),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "X-APIKEY": this.apiKey(),
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: any = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text;
      }

      if (
        !response.ok ||
        (payload &&
          typeof payload === "object" &&
          "code" in payload &&
          ![0, "0", 200, "200"].includes(payload.code))
      ) {
        const resetAt = rateLimitReset(response, payload);
        const reset = resetAt
          ? `; rate-limit reset ${new Date(resetAt * 1000).toISOString()}`
          : "";
        const message =
          payload && typeof payload === "object"
            ? String(
                payload.message ??
                  payload.error ??
                  `GMGN HTTP ${response.status}`,
              )
            : `GMGN HTTP ${response.status}`;
        throw new Error(`${message}${reset}`);
      }

      if (payload && typeof payload === "object" && "data" in payload)
        return payload.data;
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  tokenInfo(chain: GmgnChain, address: string) {
    return this.request("GET", "/v1/token/info", { chain, address });
  }

  tokenSecurity(chain: GmgnChain, address: string) {
    return this.request("GET", "/v1/token/security", { chain, address });
  }

  tokenPoolInfo(chain: GmgnChain, address: string) {
    return this.request("GET", "/v1/token/pool_info", { chain, address });
  }

  tokenTopHolders(chain: GmgnChain, address: string, query: GmgnQuery = {}) {
    return this.request("GET", "/v1/market/token_top_holders", {
      chain,
      address,
      ...query,
    });
  }

  tokenTopTraders(chain: GmgnChain, address: string, query: GmgnQuery = {}) {
    return this.request("GET", "/v1/market/token_top_traders", {
      chain,
      address,
      ...query,
    });
  }

  tokenKline(args: {
    chain: GmgnChain;
    address: string;
    resolution: "30s" | "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
    from?: number;
    to?: number;
  }) {
    return this.request("GET", "/v1/market/token_kline", args);
  }

  trending(
    chain: GmgnChain,
    interval: "1m" | "5m" | "1h" | "6h" | "24h",
    query: GmgnQuery = {},
  ) {
    return this.request("GET", "/v1/market/rank", {
      chain,
      interval,
      ...query,
    });
  }

  trenches(chain: GmgnChain, body: Record<string, unknown> = {}) {
    const hasBody = Object.keys(body).length > 0;
    const section = { filters: ["offchain", "onchain"], limit: 80 };
    const payload = hasBody
      ? body
      : {
          version: "v2",
          new_creation: { ...section },
          near_completion: { ...section },
          completed: { ...section },
        };
    return this.request("POST", "/v1/trenches", { chain }, payload);
  }

  tokenSignals(chain: GmgnChain, groups: unknown[]) {
    return this.request(
      "POST",
      "/v1/market/token_signal",
      {},
      { chain, groups },
    );
  }

  hotSearches(params: unknown[]) {
    return this.request("POST", "/v1/market/hot_searches", {}, { params });
  }

  walletActivity(
    chain: GmgnChain,
    walletAddress: string,
    query: GmgnQuery = {},
  ) {
    return this.request("GET", "/v1/user/wallet_activity", {
      chain,
      wallet_address: walletAddress,
      ...query,
    });
  }

  walletStats(chain: GmgnChain, walletAddresses: string[], period = "7d") {
    return this.request("GET", "/v1/user/wallet_stats", {
      chain,
      wallet_address: walletAddresses,
      period,
    });
  }

  walletTokenBalance(
    chain: GmgnChain,
    walletAddress: string,
    tokenAddress: string,
  ) {
    return this.request("GET", "/v1/user/wallet_token_balance", {
      chain,
      wallet_address: walletAddress,
      token_address: tokenAddress,
    });
  }

  kol(chain?: GmgnChain, limit?: number) {
    return this.request("GET", "/v1/user/kol", { chain, limit });
  }

  smartMoney(chain?: GmgnChain, limit?: number) {
    return this.request("GET", "/v1/user/smartmoney", { chain, limit });
  }

  createdTokens(
    chain: GmgnChain,
    walletAddress: string,
    query: GmgnQuery = {},
  ) {
    return this.request("GET", "/v1/user/created_tokens", {
      chain,
      wallet_address: walletAddress,
      ...query,
    });
  }

  gasPrice(chain: GmgnChain) {
    return this.request("GET", "/v1/trade/gas_price", { chain });
  }

  quote(args: {
    chain: GmgnChain;
    fromAddress: string;
    inputToken: string;
    outputToken: string;
    inputAmount: string;
    slippage: number;
  }) {
    return this.request("GET", "/v1/trade/quote", {
      chain: args.chain,
      from_address: args.fromAddress,
      input_token: args.inputToken,
      output_token: args.outputToken,
      input_amount: args.inputAmount,
      slippage: args.slippage,
    });
  }
}
