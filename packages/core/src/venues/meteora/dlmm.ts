import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Commitment,
  type Connection,
} from "@solana/web3.js";
import type { WalletRef } from "../../core/refs.ts";
import type {
  MeteoraActiveBin,
  MeteoraAddLiquidityArgs,
  MeteoraDiscoverPoolsArgs,
  MeteoraExecutionOptions,
  MeteoraExecutionResult,
  MeteoraInteger,
  MeteoraOpenPositionArgs,
  MeteoraPoolSearchResult,
  MeteoraPoolState,
  MeteoraPoolToken,
  MeteoraPositionActionArgs,
  MeteoraPositionSnapshot,
  MeteoraPreparedTransactions,
  MeteoraRemoveLiquidityArgs,
  MeteoraStrategy,
  MeteoraSwapExactInArgs,
  MeteoraSwapExactOutArgs,
  MeteoraSwapQuote,
  MeteoraUiAmount,
  MeteoraWalletPositions,
} from "./types.ts";

type DlmmModule = typeof import("@meteora-ag/dlmm");
type DlmmPool = Awaited<ReturnType<DlmmModule["default"]["create"]>>;

export type MeteoraDlmmHost = {
  connection(): Connection;
  signer(ref: WalletRef): Keypair;
  /** Resolve a public wallet address without decrypting/loading signing material. */
  walletAddress?(ref: WalletRef): string | PublicKey;
};

const DEFAULT_DATA_API = "https://dlmm.datapi.meteora.ag";
const DEFAULT_DISCOVERY_API = "https://pool-discovery-api.datapi.meteora.ag";
const STANDARD_POSITION_BINS = 69;

type MeteoraCluster = "mainnet-beta" | "devnet" | "localhost";

function meteoraCluster(): MeteoraCluster {
  const value = String(process.env.METEORA_DLMM_CLUSTER ?? "mainnet-beta")
    .trim()
    .toLowerCase();
  if (value === "mainnet-beta" || value === "devnet" || value === "localhost")
    return value;
  throw new Error(
    `METEORA_DLMM_CLUSTER must be mainnet-beta, devnet, or localhost (received ${value})`,
  );
}

let sdkPromise: Promise<DlmmModule> | null = null;

async function dlmmSdk(): Promise<DlmmModule> {
  if (!sdkPromise) sdkPromise = import("@meteora-ag/dlmm");
  return await sdkPromise;
}

function asPublicKey(value: string | PublicKey): PublicKey {
  return value instanceof PublicKey ? value : new PublicKey(String(value));
}

function publicKeyString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "toBase58" in value &&
    typeof (value as { toBase58?: unknown }).toBase58 === "function"
  ) {
    return (value as { toBase58(): string }).toBase58();
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    const result = (value as { toString(): string }).toString();
    return result && result !== "[object Object]" ? result : null;
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof (value as { toNumber?: unknown }).toNumber === "function"
  ) {
    const number = (value as { toNumber(): number }).toNumber();
    return Number.isFinite(number) ? number : null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerString(value: unknown, fallback = "0"): string {
  if (value == null) return fallback;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value))
    return Math.trunc(value).toString();
  if (typeof value === "string" && /^-?\d+$/.test(value.trim()))
    return value.trim();
  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    const result = (value as { toString(): string }).toString();
    return /^-?\d+$/.test(result) ? result : fallback;
  }
  return fallback;
}

function toBN(value: MeteoraInteger, label: string): BN {
  const normalized =
    typeof value === "bigint"
      ? value.toString()
      : typeof value === "number"
        ? Number.isSafeInteger(value)
          ? String(value)
          : ""
        : String(value).trim();
  if (!/^\d+$/.test(normalized))
    throw new Error(`${label} must be a non-negative integer`);
  return new BN(normalized, 10);
}

function decimalToRaw(value: MeteoraUiAmount, decimals: number): BN {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30)
    throw new Error(`Invalid token decimals: ${decimals}`);

  let text = String(value).trim();
  if (!text || text.startsWith("-"))
    throw new Error("Token amount must be non-negative");

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const [whole = "0", fraction = ""] = text.split(".");
    if (fraction.length > decimals) {
      const discarded = fraction.slice(decimals);
      if (/[1-9]/.test(discarded))
        throw new Error(
          `Token amount has more than ${decimals} decimal places`,
        );
    }
    const padded = fraction.slice(0, decimals).padEnd(decimals, "0");
    return new BN(`${whole}${padded}`.replace(/^0+(?=\d)/, "") || "0", 10);
  }

  const number = Number(text);
  if (!Number.isFinite(number) || number < 0)
    throw new Error("Token amount must be a finite non-negative number");
  text = number.toFixed(decimals);
  return decimalToRaw(text, decimals);
}

function normalizeStrategy(
  strategy: MeteoraStrategy,
  StrategyType: DlmmModule["StrategyType"],
): number {
  if (strategy === "spot") return StrategyType.Spot;
  if (strategy === "bid_ask") return StrategyType.BidAsk;
  if (strategy === "curve") return StrategyType.Curve;
  throw new Error(`Unsupported Meteora strategy: ${String(strategy)}`);
}

function tokenReserve(reserve: unknown): MeteoraPoolToken {
  const row = (reserve ?? {}) as Record<string, any>;
  const mint = row.mint ?? {};
  return {
    mint:
      publicKeyString(row.publicKey) ??
      publicKeyString(mint.address) ??
      publicKeyString(mint.publicKey) ??
      "",
    decimals:
      numberOrNull(mint.decimals) ??
      numberOrNull(row.decimals) ??
      numberOrNull(row.mintDecimals),
    reserve:
      publicKeyString(row.reserve) ??
      publicKeyString(row.reservePublicKey) ??
      null,
    tokenProgram:
      publicKeyString(row.tokenProgram) ??
      publicKeyString(row.tokenProgramId) ??
      publicKeyString(mint.owner) ??
      null,
  };
}

function asTxArray(
  value:
    | Transaction
    | VersionedTransaction
    | Array<Transaction | VersionedTransaction>
    | null
    | undefined,
): Array<Transaction | VersionedTransaction> {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function isLegacyTransaction(
  transaction: Transaction | VersionedTransaction,
): transaction is Transaction {
  return transaction instanceof Transaction;
}

function envEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function assertLiveTradingEnabled(options: MeteoraExecutionOptions): void {
  if (options.live !== true)
    throw new Error("Meteora write refused: execution requires { live: true }");

  const enabled =
    envEnabled("SOLARD_ENABLE_LIVE_TRADES") ||
    envEnabled("SOLWAL_ENABLE_LIVE_TRADES") ||
    envEnabled("SLRD_ENABLE_LIVE_TRADES");
  if (!enabled) {
    throw new Error(
      "Meteora write refused: set SOLARD_ENABLE_LIVE_TRADES=1 to enable live transactions",
    );
  }
}

function uniqueSigners(signers: Keypair[]): Keypair[] {
  const seen = new Set<string>();
  return signers.filter((signer) => {
    const key = signer.publicKey.toBase58();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (value == null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value))
    return value.map((entry) => safeJsonValue(entry, depth + 1));
  const key = publicKeyString(value);
  if (
    key &&
    typeof value === "object" &&
    value !== null &&
    ("toBase58" in value || "negative" in value || "words" in value)
  )
    return key;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(
      value as Record<string, unknown>,
    ))
      out[name] = safeJsonValue(entry, depth + 1);
    return out;
  }
  return String(value);
}

function extractBinId(bin: unknown): number | null {
  const row = (bin ?? {}) as Record<string, unknown>;
  return (
    numberOrNull(row.binId) ??
    numberOrNull(row.id) ??
    numberOrNull(row.activeId)
  );
}

function positionHasLiquidity(position: any): boolean {
  const bins = Array.isArray(position?.positionData?.positionBinData)
    ? position.positionData.positionBinData
    : [];
  return bins.some((bin: any) => {
    const raw =
      bin?.positionLiquidity ?? bin?.liquidityShare ?? bin?.liquidity ?? "0";
    try {
      return new BN(String(raw), 10).gt(new BN(0));
    } catch {
      return false;
    }
  });
}

function mapEntries<T>(
  value: Map<string, T> | Record<string, T>,
): Array<[string, T]> {
  return value instanceof Map ? [...value.entries()] : Object.entries(value);
}

export class MeteoraDlmmService {
  private readonly pools = new Map<string, Promise<DlmmPool>>();

  constructor(private readonly host: MeteoraDlmmHost) {}

  private dataApiBase(): string {
    return (
      process.env.METEORA_DLMM_DATA_API_URL?.trim() || DEFAULT_DATA_API
    ).replace(/\/+$/, "");
  }

  private discoveryApiBase(): string {
    return (
      process.env.METEORA_POOL_DISCOVERY_API_URL?.trim() ||
      DEFAULT_DISCOVERY_API
    ).replace(/\/+$/, "");
  }

  resolveWalletAddress(wallet: WalletRef): string {
    const publicAddress = this.host.walletAddress?.(wallet);
    if (publicAddress) return asPublicKey(publicAddress).toBase58();
    return this.host.signer(wallet).publicKey.toBase58();
  }

  clearPoolCache(pool?: string): void {
    if (pool) this.pools.delete(asPublicKey(pool).toBase58());
    else this.pools.clear();
  }

  async rawPool(pool: string, refresh = false): Promise<DlmmPool> {
    const key = asPublicKey(pool).toBase58();
    if (refresh) this.pools.delete(key);
    let pending = this.pools.get(key);
    if (!pending) {
      pending = dlmmSdk().then(({ default: DLMM }) =>
        DLMM.create(this.host.connection(), new PublicKey(key), {
          cluster: meteoraCluster(),
        }),
      );
      this.pools.set(key, pending);
    }
    const client = await pending;
    if (refresh) await client.refetchStates();
    return client;
  }

  async rawPools(pools: string[]): Promise<DlmmPool[]> {
    const keys = pools.map((pool) => asPublicKey(pool));
    const { default: DLMM } = await dlmmSdk();
    return await DLMM.createMultiple(this.host.connection(), keys, {
      cluster: meteoraCluster(),
    });
  }

  async getPoolState(
    poolAddress: string,
    refresh = false,
  ): Promise<MeteoraPoolState> {
    const pool = await this.rawPool(poolAddress, refresh);
    const activeBin = await this.getActiveBin(poolAddress, false);
    let feeInfo: Record<string, unknown> | null = null;
    let dynamicFee: string | null = null;
    try {
      feeInfo = (safeJsonValue(pool.getFeeInfo()) ?? null) as Record<
        string,
        unknown
      > | null;
    } catch {}
    try {
      dynamicFee = String(pool.getDynamicFee());
    } catch {}

    return {
      pool: pool.pubkey.toBase58(),
      tokenX: tokenReserve(pool.tokenX),
      tokenY: tokenReserve(pool.tokenY),
      binStep: numberOrNull((pool.lbPair as any)?.binStep),
      activeId: numberOrNull((pool.lbPair as any)?.activeId),
      activeBin,
      feeInfo,
      dynamicFee,
    };
  }

  async getActiveBin(
    poolAddress: string,
    refresh = false,
  ): Promise<MeteoraActiveBin> {
    const pool = await this.rawPool(poolAddress, refresh);
    const active = await pool.getActiveBin();
    const rawPrice = String((active as any).price);
    return {
      pool: pool.pubkey.toBase58(),
      binId:
        extractBinId(active) ??
        numberOrNull((pool.lbPair as any)?.activeId) ??
        0,
      price: String(pool.fromPricePerLamport(Number(rawPrice))),
      pricePerLamport: rawPrice,
    };
  }

  async getBinsAroundActiveBin(
    poolAddress: string,
    left = 20,
    right = 20,
  ): Promise<unknown> {
    const pool = await this.rawPool(poolAddress);
    return safeJsonValue(await pool.getBinsAroundActiveBin(left, right));
  }

  async getBinsBetween(
    poolAddress: string,
    lowerBinId: number,
    upperBinId: number,
  ): Promise<unknown> {
    const pool = await this.rawPool(poolAddress);
    return safeJsonValue(
      await pool.getBinsBetweenLowerAndUpperBound(lowerBinId, upperBinId),
    );
  }

  async getBinsByPrice(
    poolAddress: string,
    minPrice: number,
    maxPrice: number,
  ): Promise<unknown> {
    if (!(minPrice > 0) || !(maxPrice > 0) || minPrice > maxPrice)
      throw new Error("Meteora price range must be positive and ordered");
    const pool = await this.rawPool(poolAddress);
    // The SDK bin math operates on price-per-lamport. Solard exposes human/UI prices.
    const minPricePerLamport = Number(pool.toPricePerLamport(minPrice));
    const maxPricePerLamport = Number(pool.toPricePerLamport(maxPrice));
    return safeJsonValue(
      await pool.getBinsBetweenMinAndMaxPrice(
        minPricePerLamport,
        maxPricePerLamport,
      ),
    );
  }

  async getBinIdFromPrice(
    poolAddress: string,
    price: number,
    roundDown: boolean,
  ): Promise<number> {
    if (!(price > 0)) throw new Error("Meteora price must be positive");
    const pool = await this.rawPool(poolAddress);
    const pricePerLamport = Number(pool.toPricePerLamport(price));
    return pool.getBinIdFromPrice(pricePerLamport, roundDown);
  }

  async getBinIdFromPricePerLamport(
    poolAddress: string,
    pricePerLamport: number,
    roundDown: boolean,
  ): Promise<number> {
    if (!(pricePerLamport > 0))
      throw new Error("Meteora pricePerLamport must be positive");
    const pool = await this.rawPool(poolAddress);
    return pool.getBinIdFromPrice(pricePerLamport, roundDown);
  }

  async listPools(
    args: {
      page?: number;
      pageSize?: number;
      query?: string;
      sortBy?: string;
      filterBy?: string;
      volumeTw?: string;
      feeTvlRatioTw?: string;
    } = {},
  ): Promise<unknown> {
    return await this.dataApiGet("/pools", {
      page: args.page,
      page_size: args.pageSize,
      query: args.query,
      sort_by: args.sortBy,
      filter_by: args.filterBy,
      volume_tw: args.volumeTw,
      fee_tvl_ratio_tw: args.feeTvlRatioTw,
    });
  }

  async searchPools(
    query: string,
    limit = 10,
  ): Promise<MeteoraPoolSearchResult[]> {
    const normalized = query.trim();
    if (!normalized) throw new Error("Meteora pool search query is required");
    const url = new URL(`${this.dataApiBase()}/pools`);
    url.searchParams.set("query", normalized);
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Meteora pool search HTTP ${response.status}`);
    const body = (await response.json()) as any;
    const rows = (Array.isArray(body) ? body : (body?.data ?? [])).slice(
      0,
      Math.max(1, Math.min(100, Math.trunc(limit))),
    );

    return rows.map((row: any) => ({
      pool: String(row.address ?? row.pool_address ?? ""),
      name: row.name ? String(row.name) : null,
      binStep: numberOrNull(
        row.bin_step ?? row.dlmm_params?.bin_step ?? row.pool_config?.bin_step,
      ),
      feePct: numberOrNull(
        row.base_fee_percentage ?? row.fee_pct ?? row.pool_config?.base_fee_pct,
      ),
      tvl: numberOrNull(row.liquidity ?? row.tvl),
      volume24h: numberOrNull(
        row.trade_volume_24h ?? row.volume_24h ?? row.volume?.["24h"],
      ),
      tokenX: {
        symbol: row.mint_x_symbol ?? row.token_x?.symbol ?? null,
        mint: row.mint_x ?? row.token_x?.address ?? null,
      },
      tokenY: {
        symbol: row.mint_y_symbol ?? row.token_y?.symbol ?? null,
        mint: row.mint_y ?? row.token_y?.address ?? null,
      },
      raw: (safeJsonValue(row) ?? {}) as Record<string, unknown>,
    }));
  }

  async getIndexedPool(poolAddress: string): Promise<Record<string, unknown>> {
    const pool = asPublicKey(poolAddress).toBase58();
    const response = await fetch(`${this.dataApiBase()}/pools/${pool}`);
    if (!response.ok)
      throw new Error(`Meteora indexed pool HTTP ${response.status}`);
    return (safeJsonValue(await response.json()) ?? {}) as Record<
      string,
      unknown
    >;
  }

  async getPoolDetail(
    poolAddress: string,
    timeframe: MeteoraDiscoverPoolsArgs["timeframe"] = "5m",
  ): Promise<Record<string, unknown> | null> {
    const pool = asPublicKey(poolAddress).toBase58();
    const url = new URL(`${this.discoveryApiBase()}/pools`);
    url.searchParams.set("page_size", "1");
    url.searchParams.set("filter_by", `pool_address=${pool}`);
    url.searchParams.set("timeframe", timeframe);
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Meteora pool detail HTTP ${response.status}`);
    const body = (await response.json()) as any;
    const row = Array.isArray(body?.data) ? body.data[0] : null;
    return row ? (safeJsonValue(row) as Record<string, unknown>) : null;
  }

  async discoverPools(
    args: MeteoraDiscoverPoolsArgs = {},
  ): Promise<{ total: number | null; pools: Record<string, unknown>[] }> {
    const pageSize = Math.max(
      1,
      Math.min(100, Math.trunc(args.pageSize ?? 50)),
    );
    const url = new URL(`${this.discoveryApiBase()}/pools`);
    if (args.page != null)
      url.searchParams.set("page", String(Math.max(1, Math.trunc(args.page))));
    url.searchParams.set("page_size", String(pageSize));
    url.searchParams.set("timeframe", args.timeframe ?? "24h");
    // Important: omitted category means the broad discovery universe / UI All tab.
    // top/new/trending are explicit subsets and must never be silently selected.
    if (args.category) url.searchParams.set("category", args.category);
    if (args.sortBy?.trim())
      url.searchParams.set("sort_by", args.sortBy.trim());
    if (args.filterBy?.trim())
      url.searchParams.set("filter_by", args.filterBy.trim());

    const response = await fetch(url);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Meteora pool discovery HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    const body = (await response.json()) as any;
    const rows = Array.isArray(body?.data) ? body.data : [];
    return {
      total: numberOrNull(body?.total),
      pools: rows.map(
        (row: unknown) => (safeJsonValue(row) ?? {}) as Record<string, unknown>,
      ),
    };
  }

  private async dataApiGet(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<unknown> {
    const url = new URL(`${this.dataApiBase()}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value == null) continue;
      url.searchParams.set(key, String(value));
    }
    const response = await fetch(url);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Meteora Data API ${path} HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    return safeJsonValue(await response.json());
  }

  async getPoolOhlcv(
    poolAddress: string,
    args: {
      timeframe?: MeteoraDiscoverPoolsArgs["timeframe"];
      startTime?: number;
      endTime?: number;
    } = {},
  ): Promise<unknown> {
    const pool = asPublicKey(poolAddress).toBase58();
    return await this.dataApiGet(`/pools/${pool}/ohlcv`, {
      timeframe: args.timeframe ?? "24h",
      start_time: args.startTime,
      end_time: args.endTime,
    });
  }

  async getPoolVolumeHistory(
    poolAddress: string,
    args: {
      timeframe?: MeteoraDiscoverPoolsArgs["timeframe"];
      startTime?: number;
      endTime?: number;
    } = {},
  ): Promise<unknown> {
    const pool = asPublicKey(poolAddress).toBase58();
    return await this.dataApiGet(`/pools/${pool}/volume/history`, {
      timeframe: args.timeframe ?? "24h",
      start_time: args.startTime,
      end_time: args.endTime,
    });
  }

  async listPoolGroups(
    args: {
      page?: number;
      pageSize?: number;
      query?: string;
      sortBy?: string;
      filterBy?: string;
      volumeTw?: string;
      feeTvlRatioTw?: string;
    } = {},
  ): Promise<unknown> {
    return await this.dataApiGet("/pools/groups", {
      page: args.page,
      page_size: args.pageSize,
      query: args.query,
      sort_by: args.sortBy,
      filter_by: args.filterBy,
      volume_tw: args.volumeTw,
      fee_tvl_ratio_tw: args.feeTvlRatioTw,
    });
  }

  async getPoolGroup(
    lexicalOrderMints: string,
    args: {
      page?: number;
      pageSize?: number;
      query?: string;
      sortBy?: string;
      filterBy?: string;
    } = {},
  ): Promise<unknown> {
    const key = lexicalOrderMints.trim();
    if (!key) throw new Error("Meteora lexical_order_mints is required");
    return await this.dataApiGet(`/pools/groups/${encodeURIComponent(key)}`, {
      page: args.page,
      page_size: args.pageSize,
      query: args.query,
      sort_by: args.sortBy,
      filter_by: args.filterBy,
    });
  }

  async getPortfolio(args: {
    user: string | PublicKey;
    page?: number;
    pageSize?: number;
    daysBack?: number;
  }): Promise<unknown> {
    return await this.dataApiGet("/portfolio", {
      user: asPublicKey(args.user).toBase58(),
      page: args.page,
      page_size: args.pageSize,
      days_back: args.daysBack,
    });
  }

  async getOpenPortfolio(args: {
    user: string | PublicKey;
    page?: number;
    pageSize?: number;
    sortDirection?: "asc" | "desc";
    sortBy?: "current_balances" | "unclaimed_fee" | "fee_per_tvl24h";
  }): Promise<unknown> {
    return await this.dataApiGet("/portfolio/open", {
      user: asPublicKey(args.user).toBase58(),
      page: args.page,
      page_size: args.pageSize,
      sort_direction: args.sortDirection,
      sort_by: args.sortBy,
    });
  }

  async getPortfolioTotal(user: string | PublicKey): Promise<unknown> {
    return await this.dataApiGet("/portfolio/total", {
      user: asPublicKey(user).toBase58(),
    });
  }

  async getPositionHistory(
    positionAddress: string,
    args: {
      eventType?: "add" | "remove" | "claim_fee" | "claim_reward";
      orderDirection?: "asc" | "desc";
      page?: number;
      pageSize?: number;
    } = {},
  ): Promise<unknown> {
    const position = asPublicKey(positionAddress).toBase58();
    return await this.dataApiGet(`/positions/${position}/historical`, {
      event_type: args.eventType,
      order_direction: args.orderDirection,
      page: args.page,
      page_size: args.pageSize,
    });
  }

  async getProtocolMetrics(): Promise<unknown> {
    return await this.dataApiGet("/stats/protocol_metrics");
  }

  async getDailyProtocolFees(): Promise<unknown> {
    return await this.dataApiGet("/stats/daily/protocol_fees");
  }

  async getDailyTradingFees(): Promise<unknown> {
    return await this.dataApiGet("/stats/daily/trading_fees");
  }

  async getDailyVolume(): Promise<unknown> {
    return await this.dataApiGet("/stats/daily/volume");
  }

  async getOpenLimitOrderPools(
    wallet: string | PublicKey,
    args: { page?: number; pageSize?: number } = {},
  ): Promise<unknown> {
    const address = asPublicKey(wallet).toBase58();
    return await this.dataApiGet(
      `/wallets/${address}/limit_orders/open/pools`,
      {
        page: args.page,
        page_size: args.pageSize,
      },
    );
  }

  async getOpenLimitOrders(
    wallet: string | PublicKey,
    poolAddress: string,
    args: { page?: number; pageSize?: number } = {},
  ): Promise<unknown> {
    const address = asPublicKey(wallet).toBase58();
    const pool = asPublicKey(poolAddress).toBase58();
    return await this.dataApiGet(
      `/wallets/${address}/limit_orders/open/pools/${pool}`,
      { page: args.page, page_size: args.pageSize },
    );
  }

  async getClosedLimitOrderPools(
    wallet: string | PublicKey,
    args: { page?: number; pageSize?: number } = {},
  ): Promise<unknown> {
    const address = asPublicKey(wallet).toBase58();
    return await this.dataApiGet(
      `/wallets/${address}/limit_orders/closed/pools`,
      {
        page: args.page,
        page_size: args.pageSize,
      },
    );
  }

  async getClosedLimitOrders(
    wallet: string | PublicKey,
    poolAddress: string,
    args: { page?: number; pageSize?: number } = {},
  ): Promise<unknown> {
    const address = asPublicKey(wallet).toBase58();
    const pool = asPublicKey(poolAddress).toBase58();
    return await this.dataApiGet(
      `/wallets/${address}/limit_orders/closed/pools/${pool}`,
      { page: args.page, page_size: args.pageSize },
    );
  }

  async getLimitOrderSummary(wallet: string | PublicKey): Promise<unknown> {
    const address = asPublicKey(wallet).toBase58();
    return await this.dataApiGet(`/wallets/${address}/limit_orders/summary`);
  }

  async getLimitOrderBonusClaimed(
    wallet: string | PublicKey,
    poolAddress: string,
  ): Promise<unknown> {
    const address = asPublicKey(wallet).toBase58();
    const pool = asPublicKey(poolAddress).toBase58();
    return await this.dataApiGet(
      `/wallets/${address}/limit_orders/pools/${pool}/bonus_claimed`,
    );
  }

  async getWalletPoolTotalClaims(
    wallet: string | PublicKey,
    poolAddress: string,
  ): Promise<unknown> {
    const address = asPublicKey(wallet).toBase58();
    const pool = asPublicKey(poolAddress).toBase58();
    return await this.dataApiGet(
      `/wallets/${address}/pools/${pool}/total_claims`,
    );
  }

  async getPositionPnl(args: {
    pool: string;
    wallet: string | PublicKey;
    position?: string;
    status?: "open" | "closed";
  }): Promise<unknown> {
    const pool = asPublicKey(args.pool).toBase58();
    const wallet = asPublicKey(args.wallet).toBase58();
    const url = new URL(`${this.dataApiBase()}/positions/${pool}/pnl`);
    url.searchParams.set("user", wallet);
    url.searchParams.set("status", args.status ?? "open");
    url.searchParams.set("page_size", "100");
    url.searchParams.set("page", "1");
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Meteora position PnL HTTP ${response.status}`);
    const body = (await response.json()) as any;
    if (!args.position) return safeJsonValue(body);
    const rows = body?.positions ?? body?.data ?? [];
    return safeJsonValue(
      rows.find(
        (row: any) =>
          String(row?.positionAddress ?? row?.address ?? row?.position) ===
          args.position,
      ) ?? null,
    );
  }

  private normalizePosition(
    poolAddress: string,
    info: any,
    position: any,
  ): MeteoraPositionSnapshot {
    const data = position?.positionData ?? {};
    const activeBin = numberOrNull(info?.lbPair?.activeId);
    const lowerBin = numberOrNull(data.lowerBinId);
    const upperBin = numberOrNull(data.upperBinId);
    const owner =
      publicKeyString(data.owner) ?? publicKeyString(position?.owner) ?? null;
    return {
      position: publicKeyString(position?.publicKey) ?? "",
      pool: poolAddress,
      owner,
      activeBin,
      lowerBin,
      upperBin,
      inRange:
        activeBin != null && lowerBin != null && upperBin != null
          ? activeBin >= lowerBin && activeBin <= upperBin
          : null,
      tokenX: tokenReserve(info?.tokenX),
      tokenY: tokenReserve(info?.tokenY),
      totalXRaw: integerString(data.totalXAmount),
      totalYRaw: integerString(data.totalYAmount),
      feeXRaw: integerString(data.feeX),
      feeYRaw: integerString(data.feeY),
      claimedFeeXRaw:
        data.totalClaimedFeeXAmount == null
          ? null
          : integerString(data.totalClaimedFeeXAmount),
      claimedFeeYRaw:
        data.totalClaimedFeeYAmount == null
          ? null
          : integerString(data.totalClaimedFeeYAmount),
      rewards: (safeJsonValue(data.rewardInfos ?? data.rewards ?? []) ??
        []) as unknown[],
    };
  }

  async getWalletPositions(
    wallet: string | PublicKey,
  ): Promise<MeteoraWalletPositions> {
    const owner = asPublicKey(wallet);
    const { default: DLMM } = await dlmmSdk();
    const all = await DLMM.getAllLbPairPositionsByUser(
      this.host.connection(),
      owner,
      { cluster: meteoraCluster() },
      { isParallelExecution: true },
    );
    const positions: MeteoraPositionSnapshot[] = [];
    for (const [poolAddress, info] of mapEntries(all as any)) {
      for (const position of (info as any)?.lbPairPositionsData ?? [])
        positions.push(this.normalizePosition(poolAddress, info, position));
    }
    return {
      wallet: owner.toBase58(),
      totalPositions: positions.length,
      positions,
    };
  }

  async getMyPositions(wallet: WalletRef): Promise<MeteoraWalletPositions> {
    return await this.getWalletPositions(this.host.signer(wallet).publicKey);
  }

  async getWalletPositionsForToken(
    wallet: string | PublicKey,
    tokenMint: string | PublicKey,
  ): Promise<MeteoraWalletPositions> {
    const owner = asPublicKey(wallet);
    const token = asPublicKey(tokenMint).toBase58();
    const all = await this.getWalletPositions(owner);
    const positions = all.positions.filter(
      (position) =>
        position.tokenX.mint === token || position.tokenY.mint === token,
    );
    return {
      wallet: owner.toBase58(),
      totalPositions: positions.length,
      positions,
    };
  }

  async getPoolPositions(
    poolAddress: string,
    wallet: string | PublicKey,
  ): Promise<MeteoraPositionSnapshot[]> {
    const pool = await this.rawPool(poolAddress);
    const owner = asPublicKey(wallet);
    const result = await pool.getPositionsByUserAndLbPair(owner, {
      isParallelExecution: true,
    });
    const info = {
      lbPair: pool.lbPair,
      tokenX: pool.tokenX,
      tokenY: pool.tokenY,
    };
    return (result.userPositions ?? []).map((position: any) =>
      this.normalizePosition(pool.pubkey.toBase58(), info, position),
    );
  }

  async getPosition(
    poolAddress: string,
    positionAddress: string,
  ): Promise<MeteoraPositionSnapshot> {
    const pool = await this.rawPool(poolAddress);
    const position = await pool.getPosition(asPublicKey(positionAddress));
    const info = {
      lbPair: pool.lbPair,
      tokenX: pool.tokenX,
      tokenY: pool.tokenY,
    };
    return this.normalizePosition(pool.pubkey.toBase58(), info, position);
  }

  async findPoolForPosition(
    positionAddress: string,
    wallet: string | PublicKey,
  ): Promise<string> {
    const positions = await this.getWalletPositions(wallet);
    const found = positions.positions.find(
      (position) => position.position === positionAddress,
    );
    if (!found)
      throw new Error(
        `Meteora position ${positionAddress} was not found for wallet ${positions.wallet}`,
      );
    return found.pool;
  }

  private async resolveAmounts(
    pool: DlmmPool,
    args: {
      amountXRaw?: MeteoraInteger;
      amountYRaw?: MeteoraInteger;
      amountX?: MeteoraUiAmount;
      amountY?: MeteoraUiAmount;
    },
  ): Promise<{ x: BN; y: BN }> {
    const xToken = tokenReserve(pool.tokenX);
    const yToken = tokenReserve(pool.tokenY);
    const x =
      args.amountXRaw != null
        ? toBN(args.amountXRaw, "amountXRaw")
        : args.amountX != null
          ? decimalToRaw(args.amountX, xToken.decimals ?? 9)
          : new BN(0);
    const y =
      args.amountYRaw != null
        ? toBN(args.amountYRaw, "amountYRaw")
        : args.amountY != null
          ? decimalToRaw(args.amountY, yToken.decimals ?? 9)
          : new BN(0);
    if (x.isZero() && y.isZero())
      throw new Error("Meteora liquidity amount cannot be zero on both sides");
    return { x, y };
  }

  private async resolveRange(
    pool: DlmmPool,
    args: {
      minBinId?: number;
      maxBinId?: number;
      binsBelow?: number;
      binsAbove?: number;
      downsidePct?: number;
      upsidePct?: number;
    },
  ): Promise<{ minBinId: number; maxBinId: number; activeBinId: number }> {
    const active = await pool.getActiveBin();
    const activeBinId =
      extractBinId(active) ?? numberOrNull((pool.lbPair as any)?.activeId);
    if (activeBinId == null)
      throw new Error("Meteora active bin is unavailable");

    let minBinId = numberOrNull(args.minBinId);
    let maxBinId = numberOrNull(args.maxBinId);

    if (minBinId == null && args.binsBelow != null)
      minBinId = activeBinId - Math.max(0, Math.trunc(args.binsBelow));
    if (maxBinId == null && args.binsAbove != null)
      maxBinId = activeBinId + Math.max(0, Math.trunc(args.binsAbove));

    const activePrice = Number(
      pool.fromPricePerLamport(Number((active as any).price)),
    );
    if (minBinId == null && args.downsidePct != null) {
      const pct = Number(args.downsidePct);
      if (!(pct >= 0 && pct < 100))
        throw new Error("downsidePct must be between 0 and 100");
      const target = activePrice * (1 - pct / 100);
      minBinId = pool.getBinIdFromPrice(
        Number(pool.toPricePerLamport(target)),
        true,
      );
    }
    if (maxBinId == null && args.upsidePct != null) {
      const pct = Number(args.upsidePct);
      if (!(pct >= 0)) throw new Error("upsidePct must be non-negative");
      const target = activePrice * (1 + pct / 100);
      maxBinId = pool.getBinIdFromPrice(
        Number(pool.toPricePerLamport(target)),
        false,
      );
    }

    if (minBinId == null || maxBinId == null)
      throw new Error(
        "Meteora range is required: provide minBinId/maxBinId, binsBelow/binsAbove, or downsidePct/upsidePct",
      );
    if (!Number.isInteger(minBinId) || !Number.isInteger(maxBinId))
      throw new Error("Meteora bin IDs must be integers");
    if (minBinId > maxBinId)
      throw new Error("Meteora minBinId cannot be greater than maxBinId");

    return { minBinId, maxBinId, activeBinId };
  }

  async buildOpenPosition(
    args: MeteoraOpenPositionArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const position = Keypair.generate();
    const { StrategyType } = await dlmmSdk();
    const strategy = args.strategy ?? "spot";
    const strategyType = normalizeStrategy(strategy, StrategyType);
    const { x, y } = await this.resolveAmounts(pool, args);
    const range = await this.resolveRange(pool, args);
    const slippageBps = Math.max(
      0,
      Math.min(10_000, Math.trunc(args.slippageBps ?? 100)),
    );
    // Meteora liquidity methods take slippage as a percentage, unlike swap
    // quotes which take slippage in BPS. Keep Solard's public API consistently BPS.
    const slippagePct = slippageBps / 100;
    const width = range.maxBinId - range.minBinId + 1;
    let transactions: Array<Transaction | VersionedTransaction>;

    if (
      width > STANDARD_POSITION_BINS &&
      typeof (pool as any).createExtendedEmptyPosition === "function" &&
      typeof (pool as any).addLiquidityByStrategyChunkable === "function"
    ) {
      const create = await (pool as any).createExtendedEmptyPosition(
        range.minBinId,
        range.maxBinId,
        position.publicKey,
        wallet.publicKey,
      );
      const add = await (pool as any).addLiquidityByStrategyChunkable({
        positionPubKey: position.publicKey,
        user: wallet.publicKey,
        totalXAmount: x,
        totalYAmount: y,
        strategy: {
          minBinId: range.minBinId,
          maxBinId: range.maxBinId,
          strategyType,
        },
        slippage: slippagePct,
      });
      transactions = [...asTxArray(create), ...asTxArray(add)];
    } else {
      const built = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: position.publicKey,
        user: wallet.publicKey,
        totalXAmount: x,
        totalYAmount: y,
        strategy: {
          minBinId: range.minBinId,
          maxBinId: range.maxBinId,
          strategyType,
        },
        slippage: slippagePct,
      });
      transactions = asTxArray(built);
    }

    return {
      kind: "open-position",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions,
      extraSigners: [position],
      position: position.publicKey.toBase58(),
      metadata: {
        strategy,
        minBinId: range.minBinId,
        maxBinId: range.maxBinId,
        activeBinId: range.activeBinId,
        amountXRaw: x.toString(),
        amountYRaw: y.toString(),
        slippageBps,
      },
    };
  }

  async buildAddLiquidity(
    args: MeteoraAddLiquidityArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const positionKey = asPublicKey(args.position);
    const position = await pool.getPosition(positionKey);
    const data = (position as any)?.positionData ?? {};
    const { StrategyType } = await dlmmSdk();
    const strategy = args.strategy ?? "spot";
    const strategyType = normalizeStrategy(strategy, StrategyType);
    const { x, y } = await this.resolveAmounts(pool, args);
    const minBinId =
      numberOrNull(args.minBinId) ?? numberOrNull(data.lowerBinId);
    const maxBinId =
      numberOrNull(args.maxBinId) ?? numberOrNull(data.upperBinId);
    if (minBinId == null || maxBinId == null)
      throw new Error("Could not determine position bin range");
    const slippageBps = Math.max(
      0,
      Math.min(10_000, Math.trunc(args.slippageBps ?? 100)),
    );
    const slippagePct = slippageBps / 100;

    const method =
      typeof (pool as any).addLiquidityByStrategyChunkable === "function"
        ? (pool as any).addLiquidityByStrategyChunkable.bind(pool)
        : pool.addLiquidityByStrategy.bind(pool);
    const built = await method({
      positionPubKey: positionKey,
      user: wallet.publicKey,
      totalXAmount: x,
      totalYAmount: y,
      strategy: { minBinId, maxBinId, strategyType },
      slippage: slippagePct,
    });

    return {
      kind: "add-liquidity",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      position: positionKey.toBase58(),
      metadata: {
        strategy,
        minBinId,
        maxBinId,
        amountXRaw: x.toString(),
        amountYRaw: y.toString(),
        slippageBps,
      },
    };
  }

  async buildRemoveLiquidity(
    args: MeteoraRemoveLiquidityArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const positionKey = asPublicKey(args.position);
    const position = await pool.getPosition(positionKey);
    const data = (position as any)?.positionData ?? {};
    const fromBinId =
      numberOrNull(args.fromBinId) ?? numberOrNull(data.lowerBinId);
    const toBinId = numberOrNull(args.toBinId) ?? numberOrNull(data.upperBinId);
    if (fromBinId == null || toBinId == null)
      throw new Error("Could not determine position bin range");
    const bps = Math.trunc(args.bps ?? 10_000);
    if (bps < 1 || bps > 10_000)
      throw new Error("Meteora remove-liquidity bps must be 1..10000");

    const built = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionKey,
      fromBinId,
      toBinId,
      bps: new BN(bps),
      shouldClaimAndClose: args.claimAndClose ?? false,
      skipUnwrapSOL: args.skipUnwrapSol ?? false,
    });

    return {
      kind: args.claimAndClose ? "close-position" : "remove-liquidity",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      position: positionKey.toBase58(),
      metadata: {
        bps,
        fromBinId,
        toBinId,
        claimAndClose: args.claimAndClose ?? false,
      },
    };
  }

  async buildClaimFees(
    args: MeteoraPositionActionArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const position = await pool.getPosition(asPublicKey(args.position));
    const built = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position,
    });
    return {
      kind: "claim-fees",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      position: args.position,
    };
  }

  async buildClaimRewards(
    args: MeteoraPositionActionArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const position = await pool.getPosition(asPublicKey(args.position));
    const built = await pool.claimLMReward({
      owner: wallet.publicKey,
      position,
    });
    return {
      kind: "claim-rewards",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      position: args.position,
    };
  }

  async buildClaimPositionRewards(
    args: MeteoraPositionActionArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const position = await pool.getPosition(asPublicKey(args.position));
    const built = await pool.claimAllRewardsByPosition({
      owner: wallet.publicKey,
      position,
    });
    return {
      kind: "claim-position-rewards",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      position: args.position,
    };
  }

  private async poolPositionsForWallet(
    pool: DlmmPool,
    wallet: PublicKey,
  ): Promise<any[]> {
    const { userPositions } = await pool.getPositionsByUserAndLbPair(wallet, {
      isParallelExecution: true,
    });
    if (!userPositions.length)
      throw new Error("No Meteora positions found in this pool");
    return userPositions;
  }

  async buildClaimAllFees(args: {
    wallet: WalletRef;
    pool: string;
  }): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const positions = await this.poolPositionsForWallet(pool, wallet.publicKey);
    const built = await pool.claimAllSwapFee({
      owner: wallet.publicKey,
      positions,
    });
    return {
      kind: "claim-all-fees",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      metadata: { positions: positions.length },
    };
  }

  async buildClaimAllLmRewards(args: {
    wallet: WalletRef;
    pool: string;
  }): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const positions = await this.poolPositionsForWallet(pool, wallet.publicKey);
    const built = await pool.claimAllLMRewards({
      owner: wallet.publicKey,
      positions,
    });
    return {
      kind: "claim-all-lm-rewards",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      metadata: { positions: positions.length },
    };
  }

  async buildClaimAllRewards(args: {
    wallet: WalletRef;
    pool: string;
  }): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const positions = await this.poolPositionsForWallet(pool, wallet.publicKey);
    const built = await pool.claimAllRewards({
      owner: wallet.publicKey,
      positions,
    });
    return {
      kind: "claim-all-rewards",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      metadata: { positions: positions.length },
    };
  }

  async buildClosePosition(
    args: MeteoraPositionActionArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const positionKey = asPublicKey(args.position);
    const position = await pool.getPosition(positionKey);
    let built:
      | Transaction
      | VersionedTransaction
      | Array<Transaction | VersionedTransaction>;

    if (positionHasLiquidity(position)) {
      const data = (position as any)?.positionData ?? {};
      const fromBinId = numberOrNull(data.lowerBinId);
      const toBinId = numberOrNull(data.upperBinId);
      if (fromBinId == null || toBinId == null)
        throw new Error("Could not determine position bin range");
      built = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionKey,
        fromBinId,
        toBinId,
        bps: new BN(10_000),
        shouldClaimAndClose: true,
      });
    } else {
      built = await pool.closePosition({
        owner: wallet.publicKey,
        position,
      });
    }

    return {
      kind: "close-position",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      position: positionKey.toBase58(),
    };
  }

  async quoteSwapExactIn(
    args: Omit<MeteoraSwapExactInArgs, "wallet">,
  ): Promise<MeteoraSwapQuote> {
    const pool = await this.rawPool(args.pool, true);
    const x = tokenReserve(pool.tokenX);
    const y = tokenReserve(pool.tokenY);
    const input = args.swapForY ? x : y;
    const output = args.swapForY ? y : x;
    const amount =
      args.amountInRaw != null
        ? toBN(args.amountInRaw, "amountInRaw")
        : args.amountIn != null
          ? decimalToRaw(args.amountIn, input.decimals ?? 9)
          : null;
    if (!amount || amount.isZero())
      throw new Error("Meteora swap input amount must be positive");
    const slippage = new BN(
      Math.max(0, Math.min(10_000, Math.trunc(args.slippageBps ?? 100))),
    );
    const arrays = await pool.getBinArrayForSwap(args.swapForY);
    const quote = pool.swapQuote(
      amount,
      args.swapForY,
      slippage,
      arrays,
      args.allowPartialFill ?? false,
      args.maxExtraBinArrays,
    ) as any;
    return {
      pool: pool.pubkey.toBase58(),
      swapForY: args.swapForY,
      inputMint: input.mint,
      outputMint: output.mint,
      inAmountRaw: integerString(quote.consumedInAmount ?? amount),
      outAmountRaw: integerString(quote.outAmount),
      minOutAmountRaw: integerString(quote.minOutAmount),
      feeRaw: quote.fee == null ? null : integerString(quote.fee),
      protocolFeeRaw:
        quote.protocolFee == null ? null : integerString(quote.protocolFee),
      priceImpact: quote.priceImpact == null ? null : String(quote.priceImpact),
      endPrice: quote.endPrice == null ? null : String(quote.endPrice),
      binArrays: (quote.binArraysPubkey ?? []).map(
        (value: unknown) => publicKeyString(value) ?? String(value),
      ),
      raw: safeJsonValue(quote),
    };
  }

  async quoteSwapExactOut(
    args: Omit<MeteoraSwapExactOutArgs, "wallet">,
  ): Promise<MeteoraSwapQuote> {
    const pool = await this.rawPool(args.pool, true);
    const x = tokenReserve(pool.tokenX);
    const y = tokenReserve(pool.tokenY);
    const input = args.swapForY ? x : y;
    const output = args.swapForY ? y : x;
    const amount =
      args.amountOutRaw != null
        ? toBN(args.amountOutRaw, "amountOutRaw")
        : args.amountOut != null
          ? decimalToRaw(args.amountOut, output.decimals ?? 9)
          : null;
    if (!amount || amount.isZero())
      throw new Error("Meteora swap output amount must be positive");
    const slippage = new BN(
      Math.max(0, Math.min(10_000, Math.trunc(args.slippageBps ?? 100))),
    );
    const arrays = await pool.getBinArrayForSwap(args.swapForY);
    const quote = pool.swapQuoteExactOut(
      amount,
      args.swapForY,
      slippage,
      arrays,
      args.maxExtraBinArrays,
    ) as any;
    return {
      pool: pool.pubkey.toBase58(),
      swapForY: args.swapForY,
      inputMint: input.mint,
      outputMint: output.mint,
      inAmountRaw: integerString(quote.inAmount),
      outAmountRaw: integerString(quote.outAmount ?? amount),
      maxInAmountRaw: integerString(quote.maxInAmount),
      feeRaw: quote.fee == null ? null : integerString(quote.fee),
      protocolFeeRaw:
        quote.protocolFee == null ? null : integerString(quote.protocolFee),
      priceImpact: quote.priceImpact == null ? null : String(quote.priceImpact),
      endPrice: null,
      binArrays: (quote.binArraysPubkey ?? []).map(
        (value: unknown) => publicKeyString(value) ?? String(value),
      ),
      raw: safeJsonValue(quote),
    };
  }

  async buildSwapExactIn(
    args: MeteoraSwapExactInArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const quote = await this.quoteSwapExactIn({
      pool: args.pool,
      swapForY: args.swapForY,
      amountInRaw: args.amountInRaw,
      amountIn: args.amountIn,
      slippageBps: args.slippageBps,
      allowPartialFill: args.allowPartialFill,
      maxExtraBinArrays: args.maxExtraBinArrays,
    });
    const x = tokenReserve(pool.tokenX);
    const y = tokenReserve(pool.tokenY);
    const built = await pool.swap({
      inToken: asPublicKey(args.swapForY ? x.mint : y.mint),
      outToken: asPublicKey(args.swapForY ? y.mint : x.mint),
      inAmount: new BN(quote.inAmountRaw, 10),
      minOutAmount: new BN(quote.minOutAmountRaw ?? quote.outAmountRaw, 10),
      lbPair: pool.pubkey,
      user: wallet.publicKey,
      binArraysPubkey: quote.binArrays.map(asPublicKey),
    });
    return {
      kind: "swap-exact-in",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      metadata: {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inAmountRaw: quote.inAmountRaw,
        outAmountRaw: quote.outAmountRaw,
        minOutAmountRaw: quote.minOutAmountRaw,
        priceImpact: quote.priceImpact,
      },
    };
  }

  async buildSwapExactOut(
    args: MeteoraSwapExactOutArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const quote = await this.quoteSwapExactOut({
      pool: args.pool,
      swapForY: args.swapForY,
      amountOutRaw: args.amountOutRaw,
      amountOut: args.amountOut,
      slippageBps: args.slippageBps,
      maxExtraBinArrays: args.maxExtraBinArrays,
    });
    const x = tokenReserve(pool.tokenX);
    const y = tokenReserve(pool.tokenY);
    const built = await pool.swapExactOut({
      inToken: asPublicKey(args.swapForY ? x.mint : y.mint),
      outToken: asPublicKey(args.swapForY ? y.mint : x.mint),
      outAmount: new BN(quote.outAmountRaw, 10),
      maxInAmount: new BN(quote.maxInAmountRaw ?? quote.inAmountRaw, 10),
      lbPair: pool.pubkey,
      user: wallet.publicKey,
      binArraysPubkey: quote.binArrays.map(asPublicKey),
    });
    return {
      kind: "swap-exact-out",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      metadata: {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inAmountRaw: quote.inAmountRaw,
        maxInAmountRaw: quote.maxInAmountRaw,
        outAmountRaw: quote.outAmountRaw,
        priceImpact: quote.priceImpact,
      },
    };
  }

  async executePrepared(
    prepared: MeteoraPreparedTransactions,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    assertLiveTradingEnabled(options);
    if (prepared.transactions.length === 0) {
      throw new Error(`Meteora ${prepared.kind} produced no transactions`);
    }

    const connection = this.host.connection();
    const wallet = this.host.signer(prepared.wallet);
    const signers = uniqueSigners([wallet, ...prepared.extraSigners]);
    const commitment: Commitment = options.commitment ?? "confirmed";
    const signatures: string[] = [];

    for (const transaction of prepared.transactions) {
      if (isLegacyTransaction(transaction)) {
        if (!transaction.feePayer) transaction.feePayer = wallet.publicKey;
        if (!transaction.recentBlockhash) {
          transaction.recentBlockhash = (
            await connection.getLatestBlockhash(commitment)
          ).blockhash;
        }
        transaction.partialSign(...signers);
      } else {
        transaction.sign(signers);
      }

      if (options.simulate !== false) {
        const simulation = isLegacyTransaction(transaction)
          ? await connection.simulateTransaction(transaction)
          : await connection.simulateTransaction(transaction, {
              sigVerify: false,
            });
        if (simulation.value.err) {
          throw new Error(
            `Meteora ${prepared.kind} simulation failed: ${JSON.stringify(
              simulation.value.err,
            )}\n${simulation.value.logs?.join("\n") ?? ""}`,
          );
        }
      }

      const signature = await connection.sendRawTransaction(
        transaction.serialize(),
        {
          skipPreflight: options.skipPreflight ?? false,
          preflightCommitment: commitment,
          maxRetries: options.maxRetries,
        },
      );
      await connection.confirmTransaction(signature, commitment);
      signatures.push(signature);
    }

    this.clearPoolCache(prepared.pool);
    return {
      kind: prepared.kind,
      pool: prepared.pool,
      position: prepared.position,
      signatures,
    };
  }

  async openPosition(
    args: MeteoraOpenPositionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildOpenPosition(args),
      options,
    );
  }

  /** Agent-facing alias matching the deployment vocabulary used by LP agents. */
  async deployPosition(
    args: MeteoraOpenPositionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.openPosition(args, options);
  }

  async addLiquidity(
    args: MeteoraAddLiquidityArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildAddLiquidity(args),
      options,
    );
  }

  async removeLiquidity(
    args: MeteoraRemoveLiquidityArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildRemoveLiquidity(args),
      options,
    );
  }

  async claimFees(
    args: MeteoraPositionActionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(await this.buildClaimFees(args), options);
  }

  async claimRewards(
    args: MeteoraPositionActionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildClaimRewards(args),
      options,
    );
  }

  async claimPositionRewards(
    args: MeteoraPositionActionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildClaimPositionRewards(args),
      options,
    );
  }

  async claimAllFees(
    args: { wallet: WalletRef; pool: string },
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildClaimAllFees(args),
      options,
    );
  }

  async claimAllLmRewards(
    args: { wallet: WalletRef; pool: string },
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildClaimAllLmRewards(args),
      options,
    );
  }

  async claimAllRewards(
    args: { wallet: WalletRef; pool: string },
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildClaimAllRewards(args),
      options,
    );
  }

  async closePosition(
    args: MeteoraPositionActionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildClosePosition(args),
      options,
    );
  }

  async swapExactIn(
    args: MeteoraSwapExactInArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildSwapExactIn(args),
      options,
    );
  }

  async swapExactOut(
    args: MeteoraSwapExactOutArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildSwapExactOut(args),
      options,
    );
  }
}
