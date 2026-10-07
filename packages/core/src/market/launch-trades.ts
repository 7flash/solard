import bs58 from "bs58";
import { quoteJupiterSwap } from "../chain/jupiter-swap.ts";
import {
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  WRAPPED_SOL_MINT as WRAPPED_SOL_PUBLIC_KEY,
} from "../venues/pump/constants.ts";
import { fetchPool } from "../venues/pump/state.ts";
import { CREATE_CPMM_POOL_PROGRAM } from "@raydium-io/raydium-sdk-v2";
import { resolveCurrentMarket, type CurrentMarket } from "./current-market.ts";
import { decodeCpmmSwap } from "./raydium-cpmm-events.ts";
import { PumpSwapVenue } from "../venues/pump/pumpswap-venue.ts";
import type { TokenRow } from "../db/schema.ts";
import { readDbcMarket, dbcPrice, DYNAMIC_BONDING_CURVE_PROGRAM_ID } from "../venues/meteora/dbc.ts";
import { decodeDbcTrade, dbcTradesFromTransaction, type DbcTradeEvent } from "../venues/meteora/dbc-events.ts";
import { readDammV2Market, dammV2Price, CP_AMM_PROGRAM_ID } from "../venues/meteora/damm-v2.ts";
import { decodeDammV2Trade, dammV2TradesFromTransaction, type DammV2TradeEvent } from "../venues/meteora/damm-v2-events.ts";
import {
  fetchTokenMetadata,
  type TokenMetadata,
  type TokenMetadataMode,
} from "./token-metadata.ts";
import {
  PublicKey,
  type Commitment,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";

const RAYDIUM_LAUNCHLAB_PROGRAM_ID = new PublicKey(
  "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
);
const WRAPPED_SOL_MINT = WRAPPED_SOL_PUBLIC_KEY.toBase58();
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const DEFAULT_PUBKEY = "11111111111111111111111111111111";
const PUMP_CREATE_EVENT = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const PUMP_TRADE_EVENT = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const PUMPSWAP_CREATE_EVENT = Buffer.from([
  177, 49, 12, 210, 160, 118, 167, 116,
]);
const PUMPSWAP_BUY_EVENT = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
const PUMPSWAP_SELL_EVENT = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);
const LAUNCHLAB_CREATE_EVENT = Buffer.from([
  151, 215, 226, 9, 118, 161, 115, 174,
]);
const LAUNCHLAB_TRADE_EVENT = Buffer.from([
  189, 219, 127, 211, 78, 230, 97, 238,
]);
const RAYDIUM_MIGRATE_TO_AMM_D8 = Buffer.from([
  207, 82, 192, 145, 254, 207, 145, 223,
]);
const RAYDIUM_MIGRATE_TO_CPSWAP_D8 = Buffer.from([
  136, 92, 200, 103, 28, 218, 144, 140,
]);
const RAYDIUM_BUY_EXACT_IN_D8 = Buffer.from([
  250, 234, 13, 123, 213, 156, 19, 236,
]);
const RAYDIUM_BUY_EXACT_OUT_D8 = Buffer.from([
  24, 211, 116, 40, 105, 3, 153, 56,
]);
const RAYDIUM_SELL_EXACT_IN_D8 = Buffer.from([
  149, 39, 222, 155, 211, 124, 152, 26,
]);
const RAYDIUM_SELL_EXACT_OUT_D8 = Buffer.from([95, 200, 71, 34, 8, 9, 11, 166]);
const RAYDIUM_INITIALIZE_D8 = Buffer.from([
  175, 175, 109, 31, 13, 152, 155, 237,
]);
const RAYDIUM_INITIALIZE_V2_D8 = Buffer.from([
  67, 153, 175, 39, 218, 16, 38, 32,
]);

export type LaunchVenue = "pump" | "raydium-launchlab";
export type MigrationVenue = "pump" | "raydium-launchlab";
export type MigrationDestination = "pumpswap" | "raydium-amm" | "raydium-cpmm";
export type TradeVenue = "pump" | "pumpswap" | "raydium-launchlab" | "raydium-cpmm" | "meteora-dbc" | "meteora-damm-v2";
export type TradeSide = "buy" | "sell";

export type PumpDecodedEvent =
  | {
      kind: "launch";
      atMs: number;
      mint: string;
      name: string | null;
      symbol: string | null;
      uri: string | null;
      decimals: number;
      supplyRaw: bigint;
      quoteMint: string;
      isMayhemMode: boolean;
    }
  | {
      kind: "trade";
      atMs: number;
      mint: string;
      side: TradeSide;
      quoteMint: string;
      baseRaw: bigint;
      quoteRaw: bigint;
      virtualBaseRaw: bigint;
      virtualQuoteRaw: bigint;
    };

export type PumpSwapDecodedEvent =
  | {
      kind: "pool";
      atMs: number;
      index: number;
      creator: string;
      pool: string;
      mint: string;
      quoteMint: string;
      baseDecimals: number;
      quoteDecimals: number;
      isMayhemMode: boolean | null;
    }
  | {
      kind: "trade";
      atMs: number;
      pool: string;
      side: TradeSide;
      baseRaw: bigint;
      quoteRaw: bigint;
      poolBaseRaw: bigint;
      poolQuoteRaw: bigint;
      virtualQuoteRaw: bigint | null;
      supplyRaw: bigint | null;
    };

export type RaydiumLaunchLabDecodedEvent =
  | { kind: "pool"; pool: string }
  | {
      kind: "trade";
      pool: string;
      side: TradeSide;
      baseRaw: bigint;
      quoteRaw: bigint;
      virtualBaseRaw: bigint;
      virtualQuoteRaw: bigint;
    };

export type LaunchEvent = {
  type: "launch";
  venue: "pump" | "raydium-launchlab";
  signature: string;
  slot: number;
  atMs: number;
  mint: string;
  pool: string | null;
  decimals: number;
  supplyUi: number;
  quoteMint: string | null;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  isMayhemMode: boolean | null;
  metadata: TokenMetadata | null;
};

export type MigrationEvent = {
  type: "migration";
  venue: MigrationVenue;
  destination: MigrationDestination;
  signature: string;
  slot: number;
  atMs: number;
  mint: string;
  quoteMint: string | null;
  pool: string;
  isMayhemMode: boolean | null;
  metadata: TokenMetadata | null;
};

export type SolUsdSource = "provided" | "coinbase" | "coingecko";

export type SolUsdPrice = {
  price: number;
  source: SolUsdSource;
  atMs: number;
};

export type GetSolUsdPriceOptions = {
  maxAgeMs?: number;
  forceRefresh?: boolean;
};

export type TradeMarket = {
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  supplyRaw: bigint;
  supply: number;
  baseReserveRaw: bigint;
  baseReserve: number;
  quoteReserveRaw: bigint;
  quoteReserve: number;
  priceQuotePerToken: number;
  marketCapQuote: number;
  priceSol: number | null;
  marketCapSol: number | null;
  solUsd: number | null;
  solUsdSource: SolUsdSource | null;
  solUsdAtMs: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
};

export type TradeEvent = {
  type: "trade";
  venue: TradeVenue;
  signature: string;
  slot: number;
  atMs: number;
  mint: string;
  pool: string | null;
  side: TradeSide | null;
  baseRaw: bigint | null;
  quoteRaw: bigint | null;
  market: TradeMarket;
  metadata: TokenMetadata | null;
};

type MarketState = {
  /** Concentrated/virtual curves expose a marginal price, not a vault ratio. */
  priceQuotePerToken?: number;
  supplyRaw: bigint;
  baseReserveRaw: bigint;
  quoteReserveRaw: bigint;
};

type InternalTradeEvent = {
  type: "trade";
  venue: TradeVenue;
  signature: string;
  slot: number;
  atMs: number;
  mint: string;
  pool: string | null;
  side: TradeSide | null;
  quoteMint: string | null;
  baseDecimals: number | null;
  quoteDecimals: number | null;
  baseRaw: bigint | null;
  quoteRaw: bigint | null;
  metadata: TokenMetadata | null;
  marketState: MarketState | null;
};

export type LaunchSubscription = {
  close(): Promise<void>;
  readonly closed: Promise<void>;
};

export type MigrationSubscription = {
  readonly mode: "all" | "selected";
  addTokens(tokens: string | readonly string[]): Promise<void>;
  removeTokens(tokens: string | readonly string[]): Promise<void>;
  hasToken(token: string): boolean;
  listTokens(): string[];
  close(): Promise<void>;
  readonly closed: Promise<void>;
};

export type TradeSubscription = {
  addTokens(tokens: string | readonly string[]): Promise<void>;
  removeTokens(tokens: string | readonly string[]): Promise<void>;
  hasToken(token: string): boolean;
  listTokens(): string[];
  close(): Promise<void>;
  readonly closed: Promise<void>;
};

class Cursor {
  private offset: number;

  constructor(
    private readonly data: Buffer,
    offset = 0,
  ) {
    this.offset = offset;
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  u8(): number {
    if (this.remaining < 1) throw new Error("truncated u8");
    return this.data[this.offset++]!;
  }

  u16(): number {
    if (this.remaining < 2) throw new Error("truncated u16");
    const value = this.data.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  u32(): number {
    if (this.remaining < 4) throw new Error("truncated u32");
    const value = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  u64(): bigint {
    if (this.remaining < 8) throw new Error("truncated u64");
    const value = this.data.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  i64(): bigint {
    if (this.remaining < 8) throw new Error("truncated i64");
    const value = this.data.readBigInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  i128(): bigint {
    if (this.remaining < 16) throw new Error("truncated i128");
    const low = this.data.readBigUInt64LE(this.offset);
    const high = this.data.readBigUInt64LE(this.offset + 8);
    this.offset += 16;
    return BigInt.asIntN(128, low | (high << 64n));
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  pubkey(): string {
    if (this.remaining < 32) throw new Error("truncated pubkey");
    const value = bs58.encode(
      this.data.subarray(this.offset, this.offset + 32),
    );
    this.offset += 32;
    return value;
  }

  string(): string {
    if (this.remaining < 4) throw new Error("truncated string length");
    const length = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    if (length > 16_384 || this.remaining < length)
      throw new Error("truncated string");
    const value = this.data
      .subarray(this.offset, this.offset + length)
      .toString("utf8");
    this.offset += length;
    return value;
  }
}

function buffer(value: Uint8Array): Buffer {
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function starts(data: Buffer, discriminator: Buffer): boolean {
  return (
    data.length >= discriminator.length &&
    data.subarray(0, discriminator.length).equals(discriminator)
  );
}

function timestamp(value: bigint): number {
  const atMs = Number(value) * 1_000;
  return atMs > 0 && Number.isFinite(atMs) ? atMs : Date.now();
}

export function decodeProgramDataLogs(logs: readonly string[]): Uint8Array[] {
  const rows: Uint8Array[] = [];
  for (const line of logs) {
    const match = /^(?:Program data|Program return: \S+):\s+(.+)$/.exec(
      line.trim(),
    );
    if (!match) continue;
    try {
      rows.push(Buffer.from(match[1]!, "base64"));
    } catch {}
  }
  return rows;
}

export function decodePumpProgramData(
  value: Uint8Array,
): PumpDecodedEvent | null {
  const data = buffer(value);
  try {
    if (starts(data, PUMP_CREATE_EVENT)) {
      const c = new Cursor(data, 8);
      const name = c.string();
      const symbol = c.string();
      const uri = c.string();
      const mint = c.pubkey();
      c.pubkey();
      c.pubkey();
      c.pubkey();
      const atMs = timestamp(c.i64());
      c.u64();
      c.u64();
      c.u64();
      const supplyRaw = c.u64();
      c.pubkey();
      const isMayhemMode = c.bool();
      if (c.remaining > 0) c.bool();
      const rawQuoteMint = c.remaining >= 32 ? c.pubkey() : WRAPPED_SOL_MINT;
      return {
        kind: "launch",
        atMs,
        mint,
        name: name || null,
        symbol: symbol || null,
        uri: uri || null,
        decimals: 6,
        supplyRaw,
        quoteMint:
          rawQuoteMint === DEFAULT_PUBKEY ? WRAPPED_SOL_MINT : rawQuoteMint,
        isMayhemMode,
      };
    }
    if (!starts(data, PUMP_TRADE_EVENT)) return null;
    const c = new Cursor(data, 8);
    const mint = c.pubkey();
    const legacyQuoteRaw = c.u64();
    const baseRaw = c.u64();
    const side: TradeSide = c.bool() ? "buy" : "sell";
    c.pubkey();
    const atMs = timestamp(c.i64());
    const legacyVirtualQuoteRaw = c.u64();
    const virtualBaseRaw = c.u64();
    let quoteMint = WRAPPED_SOL_MINT;
    let quoteRaw = legacyQuoteRaw;
    let virtualQuoteRaw = legacyVirtualQuoteRaw;
    try {
      c.u64();
      c.u64();
      c.pubkey();
      c.u64();
      c.u64();
      c.pubkey();
      c.u64();
      c.u64();
      c.bool();
      c.u64();
      c.u64();
      c.u64();
      c.i64();
      c.string();
      c.bool();
      c.u64();
      c.u64();
      c.u64();
      c.u64();
      const shareholderCount = c.u32();
      for (let index = 0; index < shareholderCount; index += 1) {
        c.pubkey();
        c.u16();
      }
      const rawQuoteMint = c.pubkey();
      quoteMint =
        rawQuoteMint === DEFAULT_PUBKEY ? WRAPPED_SOL_MINT : rawQuoteMint;
      quoteRaw = c.u64();
      virtualQuoteRaw = c.u64();
    } catch {}
    return {
      kind: "trade",
      atMs,
      mint,
      side,
      quoteMint,
      baseRaw,
      quoteRaw,
      virtualBaseRaw,
      virtualQuoteRaw,
    };
  } catch {
    return null;
  }
}

export function decodePumpSwapProgramData(
  value: Uint8Array,
): PumpSwapDecodedEvent | null {
  const data = buffer(value);
  try {
    if (starts(data, PUMPSWAP_CREATE_EVENT)) {
      const c = new Cursor(data, 8);
      const atMs = timestamp(c.i64());
      const index = c.u16();
      const creator = c.pubkey();
      const mint = c.pubkey();
      const quoteMint = c.pubkey();
      const baseDecimals = c.u8();
      const quoteDecimals = c.u8();
      for (let field = 0; field < 7; field += 1) c.u64();
      c.u8();
      const pool = c.pubkey();
      let isMayhemMode: boolean | null = null;
      if (c.remaining >= 32 * 4 + 1) {
        c.pubkey();
        c.pubkey();
        c.pubkey();
        c.pubkey();
        isMayhemMode = c.bool();
      }
      return {
        kind: "pool",
        atMs,
        index,
        creator,
        pool,
        mint,
        quoteMint,
        baseDecimals,
        quoteDecimals,
        isMayhemMode,
      };
    }
    const side: TradeSide | null = starts(data, PUMPSWAP_BUY_EVENT)
      ? "buy"
      : starts(data, PUMPSWAP_SELL_EVENT)
        ? "sell"
        : null;
    if (!side) return null;
    const c = new Cursor(data, 8);
    const atMs = timestamp(c.i64());
    const baseRaw = c.u64();
    c.u64();
    c.u64();
    c.u64();
    const poolBaseRaw = c.u64();
    const poolQuoteRaw = c.u64();
    const quoteRaw = c.u64();
    for (let index = 0; index < 6; index += 1) c.u64();
    const pool = c.pubkey();
    let virtualQuoteRaw: bigint | null = null;
    let supplyRaw: bigint | null = null;
    try {
      for (let index = 0; index < 6; index += 1) c.pubkey();
      c.u64();
      c.u64();
      if (side === "buy") {
        c.bool();
        c.u64();
        c.u64();
        c.u64();
        c.i64();
        c.u64();
        c.string();
      }
      c.u64();
      c.u64();
      c.u64();
      c.u64();
      virtualQuoteRaw = c.i128();
      c.bool();
      supplyRaw = c.u64();
    } catch {}
    return {
      kind: "trade",
      atMs,
      pool,
      side,
      baseRaw,
      quoteRaw,
      poolBaseRaw,
      poolQuoteRaw,
      virtualQuoteRaw,
      supplyRaw,
    };
  } catch {
    return null;
  }
}

export function decodeRaydiumLaunchLabProgramData(
  value: Uint8Array,
): RaydiumLaunchLabDecodedEvent | null {
  const data = buffer(value);
  try {
    if (starts(data, LAUNCHLAB_CREATE_EVENT)) {
      return { kind: "pool", pool: new Cursor(data, 8).pubkey() };
    }
    if (!starts(data, LAUNCHLAB_TRADE_EVENT)) return null;
    const c = new Cursor(data, 8);
    const pool = c.pubkey();
    c.u64();
    const virtualBaseRaw = c.u64();
    const virtualQuoteRaw = c.u64();
    c.u64();
    c.u64();
    c.u64();
    c.u64();
    const amountIn = c.u64();
    const amountOut = c.u64();
    c.u64();
    c.u64();
    c.u64();
    c.u64();
    const side: TradeSide = c.u8() === 0 ? "buy" : "sell";
    c.u8();
    c.bool();
    return {
      kind: "trade",
      pool,
      side,
      baseRaw: side === "buy" ? amountOut : amountIn,
      quoteRaw: side === "buy" ? amountIn : amountOut,
      virtualBaseRaw,
      virtualQuoteRaw,
    };
  } catch {
    return null;
  }
}

type MintState = {
  mint: string;
  decimals: number;
  supplyUi: number;
  quoteMint: string | null;
  quoteDecimals: number | null;
  pool: string | null;
  isMayhemMode: boolean | null;
};

type PoolState = {
  pool: string;
  mint: string;
  baseDecimals: number;
  quoteMint: string;
  quoteDecimals: number;
};

function quoteDecimals(mint: string | null): number | null {
  if (mint === USDC_MINT) return 6;
  if (mint === WRAPPED_SOL_MINT) return 9;
  return null;
}

function priceQuote(
  baseRaw: bigint,
  quoteRaw: bigint,
  baseDecimals: number,
  quoteDecimalsValue: number,
): number | null {
  if (baseRaw <= 0n || quoteRaw <= 0n) return null;
  const baseUi = Number(baseRaw) / 10 ** baseDecimals;
  const quoteUi = Number(quoteRaw) / 10 ** quoteDecimalsValue;
  const value = baseUi > 0 ? quoteUi / baseUi : 0;
  return value > 0 && Number.isFinite(value) ? value : null;
}

function marketMetrics(
  baseReserveRaw: bigint,
  quoteReserveRaw: bigint,
  supplyRaw: bigint,
  baseDecimals: number,
  quoteDecimalsValue: number,
  marginalPrice?: number,
): { priceQuotePerToken: number; marketCapQuote: number } | null {
  const priceQuotePerToken = marginalPrice ?? priceQuote(
    baseReserveRaw,
    quoteReserveRaw,
    baseDecimals,
    quoteDecimalsValue,
  );
  if (priceQuotePerToken == null || !Number.isFinite(priceQuotePerToken) || priceQuotePerToken <= 0 || supplyRaw <= 0n) return null;
  const supplyUi = Number(supplyRaw) / 10 ** baseDecimals;
  const marketCapQuote = priceQuotePerToken * supplyUi;
  if (!Number.isFinite(marketCapQuote) || marketCapQuote <= 0) return null;
  return { priceQuotePerToken, marketCapQuote };
}

function tradeMarketFromTradeEvent(
  event: InternalTradeEvent,
  solUsd: SolUsdPrice | null,
  quoteSolPerToken: number | null = null,
): TradeMarket | null {
  if (
    event.quoteMint == null ||
    event.baseDecimals == null ||
    event.quoteDecimals == null ||
    event.marketState == null
  )
    return null;
  const metrics = marketMetrics(
    event.marketState.baseReserveRaw,
    event.marketState.quoteReserveRaw,
    event.marketState.supplyRaw,
    event.baseDecimals,
    event.quoteDecimals,
    event.marketState.priceQuotePerToken,
  );
  if (!metrics) return null;
  const supply = Number(event.marketState.supplyRaw) / 10 ** event.baseDecimals;
  const baseReserve =
    Number(event.marketState.baseReserveRaw) / 10 ** event.baseDecimals;
  const quoteReserve =
    Number(event.marketState.quoteReserveRaw) / 10 ** event.quoteDecimals;
  let priceSol: number | null = null;
  let marketCapSol: number | null = null;
  let priceUsd: number | null = null;
  let marketCapUsd: number | null = null;
  if (event.quoteMint === WRAPPED_SOL_MINT) {
    priceSol = metrics.priceQuotePerToken;
    marketCapSol = metrics.marketCapQuote;
    if (solUsd) {
      priceUsd = priceSol * solUsd.price;
      marketCapUsd = marketCapSol * solUsd.price;
    }
  } else if (event.quoteMint === USDC_MINT) {
    priceUsd = metrics.priceQuotePerToken;
    marketCapUsd = metrics.marketCapQuote;
    if (solUsd) {
      priceSol = priceUsd / solUsd.price;
      marketCapSol = marketCapUsd / solUsd.price;
    }
  } else if (quoteSolPerToken != null && Number.isFinite(quoteSolPerToken) && quoteSolPerToken > 0) {
    priceSol = metrics.priceQuotePerToken * quoteSolPerToken;
    marketCapSol = metrics.marketCapQuote * quoteSolPerToken;
    if (solUsd) {
      priceUsd = priceSol * solUsd.price;
      marketCapUsd = marketCapSol * solUsd.price;
    }
  }
  return {
    quoteMint: event.quoteMint,
    baseDecimals: event.baseDecimals,
    quoteDecimals: event.quoteDecimals,
    supplyRaw: event.marketState.supplyRaw,
    supply,
    baseReserveRaw: event.marketState.baseReserveRaw,
    baseReserve,
    quoteReserveRaw: event.marketState.quoteReserveRaw,
    quoteReserve,
    priceQuotePerToken: metrics.priceQuotePerToken,
    marketCapQuote: metrics.marketCapQuote,
    priceSol,
    marketCapSol,
    solUsd: solUsd?.price ?? null,
    solUsdSource: solUsd?.source ?? null,
    solUsdAtMs: solUsd?.atMs ?? null,
    priceUsd,
    marketCapUsd,
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function loadSolUsd(): Promise<SolUsdPrice> {
  try {
    const raw = (await fetchJson(
      "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    )) as { data?: { amount?: unknown } };
    const value = Number(raw.data?.amount);
    if (Number.isFinite(value) && value > 0)
      return { price: value, source: "coinbase", atMs: Date.now() };
  } catch {}
  const raw = (await fetchJson(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  )) as { solana?: { usd?: unknown } };
  const value = Number(raw.solana?.usd);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("SOL/USD unavailable");
  return { price: value, source: "coingecko", atMs: Date.now() };
}

const DEFAULT_SOL_USD_MAX_AGE_MS = 15_000;
let sharedSolUsdPrice: SolUsdPrice | null = null;
let sharedSolUsdPending: Promise<SolUsdPrice> | null = null;

export async function getSolUsdPrice(
  options: GetSolUsdPriceOptions = {},
): Promise<SolUsdPrice> {
  const maxAgeMs = Math.max(
    1_000,
    Math.trunc(options.maxAgeMs ?? DEFAULT_SOL_USD_MAX_AGE_MS),
  );
  if (
    !options.forceRefresh &&
    sharedSolUsdPrice &&
    Date.now() - sharedSolUsdPrice.atMs < maxAgeMs
  )
    return sharedSolUsdPrice;
  if (sharedSolUsdPending) return await sharedSolUsdPending;
  sharedSolUsdPending = loadSolUsd();
  try {
    sharedSolUsdPrice = await sharedSolUsdPending;
    return sharedSolUsdPrice;
  } catch (error) {
    if (sharedSolUsdPrice) return sharedSolUsdPrice;
    throw error;
  } finally {
    sharedSolUsdPending = null;
  }
}

function solUsdLoader(
  input: number | (() => number | Promise<number>) | undefined,
  refreshMs: number,
  status: (event: string, data?: Record<string, unknown>) => void,
) {
  if (input == null) {
    return async (): Promise<SolUsdPrice | null> => {
      try {
        return await getSolUsdPrice({ maxAgeMs: refreshMs });
      } catch (error) {
        status("sol-usd-error", {
          error: error instanceof Error ? error.message : String(error),
          cached: null,
        });
        return null;
      }
    };
  }
  let cached: SolUsdPrice | null =
    typeof input === "number" && Number.isFinite(input) && input > 0
      ? { price: input, source: "provided", atMs: Date.now() }
      : null;
  let pending: Promise<SolUsdPrice | null> | null = null;
  return async (): Promise<SolUsdPrice | null> => {
    if (cached && Date.now() - cached.atMs < refreshMs) return cached;
    if (pending) return await pending;
    pending = (async () => {
      try {
        const value =
          typeof input === "function" ? Number(await input()) : Number(input);
        if (!Number.isFinite(value) || value <= 0)
          throw new Error("Provided SOL/USD source returned an invalid value");
        cached = { price: value, source: "provided", atMs: Date.now() };
        return cached;
      } catch (error) {
        status("sol-usd-error", {
          error: error instanceof Error ? error.message : String(error),
          cached: cached?.price ?? null,
        });
        return cached;
      } finally {
        pending = null;
      }
    })();
    return await pending;
  };
}

function keyText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof (value as { toBase58?: unknown }).toBase58 === "function")
    return (value as { toBase58(): string }).toBase58();
  if (
    value &&
    typeof (value as { pubkey?: { toBase58?: unknown } }).pubkey?.toBase58 ===
      "function"
  )
    return (value as { pubkey: { toBase58(): string } }).pubkey.toBase58();
  if (value && typeof (value as { pubkey?: unknown }).pubkey === "string")
    return (value as { pubkey: string }).pubkey;
  return null;
}

function instructions(tx: ParsedTransactionWithMeta): unknown[] {
  const outer =
    (tx.transaction.message as unknown as { instructions?: unknown[] })
      .instructions ?? [];
  const inner = (tx.meta?.innerInstructions ?? []).flatMap(
    (group) => group.instructions ?? [],
  );
  return [...outer, ...inner];
}

function initializedMints(tx: ParsedTransactionWithMeta): string[] {
  const out = new Set<string>();
  for (const value of instructions(tx)) {
    const parsed = (
      value as { parsed?: { type?: unknown; info?: { mint?: unknown } } }
    )?.parsed;
    const type = String(parsed?.type ?? "").toLowerCase();
    if (type !== "initializemint" && type !== "initializemint2") continue;
    const mint =
      keyText(parsed?.info?.mint) ?? String(parsed?.info?.mint ?? "");
    if (mint && mint !== WRAPPED_SOL_MINT && mint !== USDC_MINT) out.add(mint);
  }
  return [...out];
}

function tokenBalances(rows: readonly unknown[] | null | undefined) {
  return (rows ?? []).map((value) => {
    const row = value as {
      accountIndex?: unknown;
      mint?: unknown;
      owner?: unknown;
      uiTokenAmount?: { amount?: unknown; decimals?: unknown };
    };
    let raw = 0n;
    try {
      raw = BigInt(String(row.uiTokenAmount?.amount ?? "0"));
    } catch {}
    return {
      accountIndex: Number(row.accountIndex),
      mint: String(row.mint ?? ""),
      owner: row.owner ? String(row.owner) : null,
      raw,
      decimals: Number(row.uiTokenAmount?.decimals ?? 0),
    };
  });
}

function supplyFromTransaction(
  tx: ParsedTransactionWithMeta,
  mint: string,
): { decimals: number; supplyUi: number } | null {
  const rows = tokenBalances(tx.meta?.postTokenBalances).filter(
    (row) => row.mint === mint,
  );
  if (!rows.length) return null;
  const decimals = rows[0]!.decimals;
  const byAccount = new Map<number, bigint>();
  for (const row of rows) byAccount.set(row.accountIndex, row.raw);
  const raw = [...byAccount.values()].reduce((sum, amount) => sum + amount, 0n);
  const supplyUi = Number(raw) / 10 ** decimals;
  return Number.isFinite(supplyUi) && supplyUi > 0
    ? { decimals, supplyUi }
    : null;
}

type ProgramDataEntry = {
  programId: string | null;
  data: Uint8Array;
};

type TradeTokenState = {
  mint: string;
  decimals: number | null;
  supplyRaw: bigint | null;
  supplyRefreshedAtMs: number;
  quoteMint: string | null;
  quoteDecimals: number | null;
  pool: string | null;
};

type PumpSwapPoolIdentity = {
  pool: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
};

function programDataEntries(logs: readonly string[]): ProgramDataEntry[] {
  const rows: ProgramDataEntry[] = [];
  const stack: string[] = [];
  for (const raw of logs) {
    const line = raw.trim();
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    const returned = /^Program return: (\S+):\s+(.+)$/.exec(line);
    if (returned) {
      try {
        rows.push({
          programId: returned[1]!,
          data: Buffer.from(returned[2]!, "base64"),
        });
      } catch {}
      continue;
    }
    const data = /^Program data:\s+(.+)$/.exec(line);
    if (data) {
      try {
        rows.push({
          programId: stack.at(-1) ?? null,
          data: Buffer.from(data[1]!, "base64"),
        });
      } catch {}
      continue;
    }
    const completed = /^Program (\S+) (?:success|failed:)/.exec(line);
    if (!completed) continue;
    const index = stack.lastIndexOf(completed[1]!);
    if (index >= 0) stack.splice(index);
  }
  return rows;
}

function tokenList(value: string | readonly string[]): string[] {
  const rows = typeof value === "string" ? [value] : [...value];
  return [...new Set(rows.map((mint) => new PublicKey(mint).toBase58()))];
}

function quoteFromTransaction(
  tx: ParsedTransactionWithMeta,
  mint: string,
): { mint: string; decimals: number } | null {
  const rows = [
    ...tokenBalances(tx.meta?.preTokenBalances),
    ...tokenBalances(tx.meta?.postTokenBalances),
  ].filter((row) => row.mint && row.mint !== mint);
  const quotes = new Map<string, number>();
  for (const row of rows) quotes.set(row.mint, row.decimals);
  if (quotes.size !== 1) return null;
  const quote = [...quotes.entries()][0];
  return quote ? { mint: quote[0], decimals: quote[1] } : null;
}

function instructionData(
  value: unknown,
  programId: PublicKey,
): {
  accounts: string[];
  data: Buffer;
} | null {
  const row = value as {
    programId?: unknown;
    accounts?: unknown[];
    data?: unknown;
  };
  if (keyText(row.programId) !== programId.toBase58()) return null;
  if (typeof row.data !== "string" || !Array.isArray(row.accounts)) return null;
  try {
    return {
      accounts: row.accounts
        .map((account) => keyText(account))
        .filter((account): account is string => Boolean(account)),
      data: Buffer.from(bs58.decode(row.data)),
    };
  } catch {
    return null;
  }
}

function findInstruction(
  tx: ParsedTransactionWithMeta,
  programId: PublicKey,
  discriminators: readonly Buffer[],
): { accounts: string[]; data: Buffer } | null {
  for (const value of instructions(tx)) {
    const decoded = instructionData(value, programId);
    if (!decoded) continue;
    if (
      discriminators.some((discriminator) =>
        starts(decoded.data, discriminator),
      )
    )
      return decoded;
  }
  return null;
}

function launchLabQuoteFromTransaction(
  tx: ParsedTransactionWithMeta,
  mint: string,
  pool?: string | null,
): { mint: string; decimals: number | null } | null {
  const balances = [
    ...tokenBalances(tx.meta?.preTokenBalances),
    ...tokenBalances(tx.meta?.postTokenBalances),
  ];
  const decimalsByMint = new Map<string, number>();
  for (const row of balances) decimalsByMint.set(row.mint, row.decimals);
  for (const value of instructions(tx)) {
    const decoded = instructionData(value, RAYDIUM_LAUNCHLAB_PROGRAM_ID);
    if (!decoded) continue;
    let poolIndex = -1;
    let baseIndex = -1;
    let quoteIndex = -1;
    if (
      starts(decoded.data, RAYDIUM_BUY_EXACT_IN_D8) ||
      starts(decoded.data, RAYDIUM_BUY_EXACT_OUT_D8) ||
      starts(decoded.data, RAYDIUM_SELL_EXACT_IN_D8) ||
      starts(decoded.data, RAYDIUM_SELL_EXACT_OUT_D8)
    ) {
      poolIndex = 4;
      baseIndex = 9;
      quoteIndex = 10;
    } else if (
      starts(decoded.data, RAYDIUM_INITIALIZE_D8) ||
      starts(decoded.data, RAYDIUM_INITIALIZE_V2_D8)
    ) {
      poolIndex = 5;
      baseIndex = 6;
      quoteIndex = 7;
    }
    if (poolIndex < 0 || decoded.accounts.length <= quoteIndex) continue;
    if (decoded.accounts[baseIndex] !== mint) continue;
    if (pool && decoded.accounts[poolIndex] !== pool) continue;
    const quoteMint = decoded.accounts[quoteIndex]!;
    return {
      mint: quoteMint,
      decimals: decimalsByMint.get(quoteMint) ?? quoteDecimals(quoteMint),
    };
  }
  return null;
}

async function loadParsedTransaction(
  connection: Connection,
  signature: string,
): Promise<ParsedTransactionWithMeta | null> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const tx = await connection.getParsedTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 1,
      });
      if (tx) return tx as ParsedTransactionWithMeta;
    } catch {
      if (attempt === 5)
        throw new Error(`Could not load migration transaction ${signature}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
  }
  return null;
}

function canonicalPumpPoolCreator(mint: string): string {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), new PublicKey(mint).toBuffer()],
    PUMP_PROGRAM_ID,
  )[0].toBase58();
}

function raydiumMigrationHint(logs: readonly string[]): boolean {
  return logs.some((line) => {
    const normalized = line.toLowerCase().replaceAll("_", "");
    return (
      normalized.includes("instruction: migratetoamm") ||
      normalized.includes("instruction: migratetocpswap")
    );
  });
}

async function resolveEventMetadata(args: {
  connection: Connection;
  mode: TokenMetadataMode;
  commitment: Commitment;
  mint: string;
  status: (event: string, data?: Record<string, unknown>) => void;
  hint?: { name?: string | null; symbol?: string | null; uri?: string | null };
}): Promise<TokenMetadata | null> {
  if (args.mode === false) return null;
  try {
    return await fetchTokenMetadata(args.connection, args.mint, {
      mode: args.mode,
      commitment: args.commitment,
      hint: args.hint,
    });
  } catch (error) {
    args.status("metadata-enrichment-error", {
      mint: args.mint,
      mode: args.mode,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function callbackError(
  status: (event: string, data?: Record<string, unknown>) => void,
  event: { type: string; venue: string; signature: string },
  error: unknown,
): void {
  status("callback-error", {
    type: event.type,
    venue: event.venue,
    signature: event.signature,
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function subscribeLaunches(options: {
  connection: Connection;
  venues?: readonly LaunchVenue[];
  commitment?: Commitment;
  metadata?: TokenMetadataMode;
  signal?: AbortSignal;
  onLaunch: (event: LaunchEvent) => void | Promise<void>;
  onStatus?: (event: string, data?: Record<string, unknown>) => void;
}): Promise<LaunchSubscription> {
  const venues = new Set<LaunchVenue>(
    options.venues ?? ["pump", "raydium-launchlab"],
  );
  const commitment = options.commitment ?? "processed";
  const metadataMode = options.metadata ?? false;
  const subscriptionIds: number[] = [];
  const launchLabFetches = new Set<string>();
  let stopped = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const status = (event: string, data?: Record<string, unknown>) => {
    try {
      options.onStatus?.(event, data);
    } catch {}
  };

  const deliver = async (value: Omit<LaunchEvent, "metadata">) => {
    const event: LaunchEvent = {
      ...value,
      metadata: await resolveEventMetadata({
        connection: options.connection,
        mode: metadataMode,
        commitment,
        mint: value.mint,
        status,
        hint: { name: value.name, symbol: value.symbol, uri: value.uri },
      }),
    };
    try {
      await options.onLaunch(event);
    } catch (error) {
      callbackError(status, event, error);
    }
  };

  const enrichLaunchLab = async (
    signature: string,
    pool: string,
    slot: number,
  ) => {
    if (launchLabFetches.has(signature) || stopped) return;
    launchLabFetches.add(signature);
    try {
      const tx = await options.connection.getParsedTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 1,
      });
      if (!tx || stopped) return;
      const parsed = tx as ParsedTransactionWithMeta;
      const mint = initializedMints(parsed)[0];
      if (!mint) return;
      let supply = supplyFromTransaction(parsed, mint);
      if (!supply) {
        const loaded = await options.connection.getTokenSupply(
          new PublicKey(mint),
          "confirmed",
        );
        supply = {
          decimals: loaded.value.decimals,
          supplyUi: Number(loaded.value.uiAmountString ?? "0"),
        };
      }
      const quote =
        launchLabQuoteFromTransaction(parsed, mint, pool) ??
        quoteFromTransaction(parsed, mint);
      await deliver({
        type: "launch",
        venue: "raydium-launchlab",
        signature,
        slot: slot || parsed.slot,
        atMs: (parsed.blockTime ?? Math.floor(Date.now() / 1_000)) * 1_000,
        mint,
        pool,
        decimals: supply.decimals,
        supplyUi: supply.supplyUi,
        quoteMint: quote?.mint ?? null,
        name: null,
        symbol: null,
        uri: null,
        isMayhemMode: false,
      });
    } catch (error) {
      status("launch-enrichment-error", {
        venue: "raydium-launchlab",
        signature,
        pool,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      launchLabFetches.delete(signature);
    }
  };

  if (venues.has("pump")) {
    subscriptionIds.push(
      options.connection.onLogs(
        PUMP_PROGRAM_ID,
        (logs, context) => {
          if (logs.err || stopped) return;
          for (const data of decodeProgramDataLogs(logs.logs)) {
            const decoded = decodePumpProgramData(data);
            if (!decoded || decoded.kind !== "launch") continue;
            void deliver({
              type: "launch",
              venue: "pump",
              signature: logs.signature,
              slot: context.slot,
              atMs: decoded.atMs,
              mint: decoded.mint,
              pool: null,
              decimals: decoded.decimals,
              supplyUi: Number(decoded.supplyRaw) / 10 ** decoded.decimals,
              quoteMint: decoded.quoteMint,
              name: decoded.name,
              symbol: decoded.symbol,
              uri: decoded.uri,
              isMayhemMode: decoded.isMayhemMode,
            });
          }
        },
        commitment,
      ),
    );
  }

  if (venues.has("raydium-launchlab")) {
    subscriptionIds.push(
      options.connection.onLogs(
        RAYDIUM_LAUNCHLAB_PROGRAM_ID,
        (logs, context) => {
          if (logs.err || stopped) return;
          for (const data of decodeProgramDataLogs(logs.logs)) {
            const decoded = decodeRaydiumLaunchLabProgramData(data);
            if (decoded?.kind === "pool")
              void enrichLaunchLab(logs.signature, decoded.pool, context.slot);
          }
        },
        commitment,
      ),
    );
  }

  status("listening", {
    venues: [...venues],
    subscriptions: subscriptionIds.length,
    metadata: metadataMode,
  });

  const close = async () => {
    if (stopped) return;
    stopped = true;
    await Promise.allSettled(
      subscriptionIds.map((id) => options.connection.removeOnLogsListener(id)),
    );
    resolveClosed();
  };

  if (options.signal) {
    if (options.signal.aborted) await close();
    else
      options.signal.addEventListener("abort", () => void close(), {
        once: true,
      });
  }

  return { close, closed };
}

export async function subscribeMigrations(options: {
  connection: Connection;
  tokens?: readonly string[];
  venues?: readonly MigrationVenue[];
  commitment?: Commitment;
  metadata?: TokenMetadataMode;
  signal?: AbortSignal;
  onMigration: (event: MigrationEvent) => void | Promise<void>;
  onStatus?: (event: string, data?: Record<string, unknown>) => void;
}): Promise<MigrationSubscription> {
  const venues = new Set<MigrationVenue>(
    options.venues ?? ["pump", "raydium-launchlab"],
  );
  const commitment = options.commitment ?? "processed";
  const metadataMode = options.metadata ?? false;
  const mode = options.tokens === undefined ? "all" : "selected";
  const tokens = new Set(tokenList(options.tokens ?? []));
  const subscriptionIds: number[] = [];
  const pendingRaydium = new Set<string>();
  const seen = new Set<string>();
  let stopped = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const status = (event: string, data?: Record<string, unknown>) => {
    try {
      options.onStatus?.(event, data);
    } catch {}
  };

  const matches = (mint: string) => mode === "all" || tokens.has(mint);

  const deliver = async (value: Omit<MigrationEvent, "metadata">) => {
    if (!matches(value.mint) || stopped) return;
    const key = `${value.signature}:${value.destination}:${value.mint}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 10_000) seen.clear();
    const event: MigrationEvent = {
      ...value,
      metadata: await resolveEventMetadata({
        connection: options.connection,
        mode: metadataMode,
        commitment,
        mint: value.mint,
        status,
      }),
    };
    try {
      await options.onMigration(event);
    } catch (error) {
      callbackError(status, event, error);
    }
  };

  if (venues.has("pump")) {
    subscriptionIds.push(
      options.connection.onLogs(
        PUMP_AMM_PROGRAM_ID,
        (logs, context) => {
          if (logs.err || stopped) return;
          for (const entry of programDataEntries(logs.logs)) {
            if (entry.programId !== PUMP_AMM_PROGRAM_ID.toBase58()) continue;
            const decoded = decodePumpSwapProgramData(entry.data);
            if (!decoded || decoded.kind !== "pool" || decoded.index !== 0)
              continue;
            let creator: string;
            try {
              creator = canonicalPumpPoolCreator(decoded.mint);
            } catch {
              continue;
            }
            if (decoded.creator !== creator) continue;
            void deliver({
              type: "migration",
              venue: "pump",
              destination: "pumpswap",
              signature: logs.signature,
              slot: context.slot,
              atMs: decoded.atMs,
              mint: decoded.mint,
              quoteMint: decoded.quoteMint,
              pool: decoded.pool,
              isMayhemMode: decoded.isMayhemMode,
            });
          }
        },
        commitment,
      ),
    );
  }

  const enrichRaydium = async (signature: string, slot: number) => {
    if (pendingRaydium.has(signature) || stopped) return;
    pendingRaydium.add(signature);
    try {
      const tx = await loadParsedTransaction(options.connection, signature);
      if (!tx || stopped) return;
      const amm = findInstruction(tx, RAYDIUM_LAUNCHLAB_PROGRAM_ID, [
        RAYDIUM_MIGRATE_TO_AMM_D8,
      ]);
      if (amm && amm.accounts.length > 13) {
        await deliver({
          type: "migration",
          venue: "raydium-launchlab",
          destination: "raydium-amm",
          signature,
          slot: slot || tx.slot,
          atMs: (tx.blockTime ?? Math.floor(Date.now() / 1_000)) * 1_000,
          mint: amm.accounts[1]!,
          quoteMint: amm.accounts[2]!,
          pool: amm.accounts[13]!,
          isMayhemMode: null,
        });
        return;
      }
      const cpswap = findInstruction(tx, RAYDIUM_LAUNCHLAB_PROGRAM_ID, [
        RAYDIUM_MIGRATE_TO_CPSWAP_D8,
      ]);
      if (cpswap && cpswap.accounts.length > 5) {
        await deliver({
          type: "migration",
          venue: "raydium-launchlab",
          destination: "raydium-cpmm",
          signature,
          slot: slot || tx.slot,
          atMs: (tx.blockTime ?? Math.floor(Date.now() / 1_000)) * 1_000,
          mint: cpswap.accounts[1]!,
          quoteMint: cpswap.accounts[2]!,
          pool: cpswap.accounts[5]!,
          isMayhemMode: null,
        });
      }
    } catch (error) {
      status("migration-enrichment-error", {
        venue: "raydium-launchlab",
        signature,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      pendingRaydium.delete(signature);
    }
  };

  if (venues.has("raydium-launchlab")) {
    subscriptionIds.push(
      options.connection.onLogs(
        RAYDIUM_LAUNCHLAB_PROGRAM_ID,
        (logs, context) => {
          if (logs.err || stopped || !raydiumMigrationHint(logs.logs)) return;
          void enrichRaydium(logs.signature, context.slot);
        },
        commitment,
      ),
    );
  }

  status("listening", {
    venues: [...venues],
    mode,
    tokens: mode === "selected" ? [...tokens] : undefined,
    subscriptions: subscriptionIds.length,
    metadata: metadataMode,
  });

  const assertSelected = () => {
    if (mode === "all") {
      throw new Error(
        "This migration subscription watches all tokens. Pass tokens: [] to use addTokens/removeTokens.",
      );
    }
  };

  const addTokens = async (value: string | readonly string[]) => {
    assertSelected();
    for (const mint of tokenList(value)) tokens.add(mint);
    status("tokens-changed", { tokens: [...tokens] });
  };

  const removeTokens = async (value: string | readonly string[]) => {
    assertSelected();
    for (const mint of tokenList(value)) tokens.delete(mint);
    status("tokens-changed", { tokens: [...tokens] });
  };

  const close = async () => {
    if (stopped) return;
    stopped = true;
    await Promise.allSettled(
      subscriptionIds.map((id) => options.connection.removeOnLogsListener(id)),
    );
    resolveClosed();
  };

  if (options.signal) {
    if (options.signal.aborted) await close();
    else
      options.signal.addEventListener("abort", () => void close(), {
        once: true,
      });
  }

  return {
    mode,
    addTokens,
    removeTokens,
    hasToken(token) {
      try {
        const mint = new PublicKey(token).toBase58();
        return mode === "all" || tokens.has(mint);
      } catch {
        return false;
      }
    },
    listTokens() {
      return [...tokens];
    },
    close,
    closed,
  };
}

async function subscribeTradeStream(options: {
  connection: Connection;
  tokens: readonly string[];
  venues?: readonly TradeVenue[];
  commitment?: Commitment;
  metadata?: TokenMetadataMode;
  signal?: AbortSignal;
  onTrade: (event: InternalTradeEvent) => void | Promise<void>;
  onStatus?: (event: string, data?: Record<string, unknown>) => void;
}): Promise<TradeSubscription> {
  const venues = new Set<TradeVenue>(
    options.venues ?? ["pump", "pumpswap", "raydium-launchlab", "raydium-cpmm", "meteora-dbc", "meteora-damm-v2"],
  );
  const commitment = options.commitment ?? "processed";
  const metadataMode = options.metadata ?? false;
  const subscriptions = new Map<string, number>();
  const states = new Map<string, TradeTokenState>();
  const metadataFetches = new Map<string, Promise<void>>();
  const pumpSwapPools = new Map<string, Promise<PumpSwapPoolIdentity>>();
  const cpmmPools = new Map<string, Promise<CurrentMarket | null>>();
  const SUPPLY_REFRESH_MS = 5 * 60_000;
  let stopped = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const status = (event: string, data?: Record<string, unknown>) => {
    try {
      options.onStatus?.(event, data);
    } catch {}
  };

  const deliver = async (value: Omit<InternalTradeEvent, "metadata">) => {
    const event: InternalTradeEvent = {
      ...value,
      metadata: await resolveEventMetadata({
        connection: options.connection,
        mode: metadataMode,
        commitment,
        mint: value.mint,
        status,
      }),
    };
    try {
      await options.onTrade(event);
    } catch (error) {
      callbackError(status, event, error);
    }
  };

  const resolvePumpSwapPool = async (poolText: string) => {
    const cached = pumpSwapPools.get(poolText);
    if (cached) return await cached;
    const pending = (async (): Promise<PumpSwapPoolIdentity> => {
      const pool = await fetchPool(options.connection, new PublicKey(poolText));
      const [baseSupply, quoteSupply] = await Promise.all([
        options.connection.getTokenSupply(pool.baseMint, "confirmed"),
        options.connection.getTokenSupply(pool.quoteMint, "confirmed"),
      ]);
      return {
        pool: poolText,
        baseMint: pool.baseMint.toBase58(),
        quoteMint: pool.quoteMint.toBase58(),
        baseDecimals: baseSupply.value.decimals,
        quoteDecimals: quoteSupply.value.decimals,
      };
    })();
    pumpSwapPools.set(poolText, pending);
    try {
      return await pending;
    } catch (error) {
      pumpSwapPools.delete(poolText);
      throw error;
    }
  };

  const refreshWatchedSupply = async (state: TradeTokenState) => {
    const now = Date.now();
    if (
      state.supplyRaw != null &&
      now - state.supplyRefreshedAtMs < SUPPLY_REFRESH_MS
    )
      return;
    const supply = await options.connection.getTokenSupply(
      new PublicKey(state.mint),
      "confirmed",
    );
    state.decimals = supply.value.decimals;
    state.supplyRaw = BigInt(supply.value.amount);
    state.supplyRefreshedAtMs = now;
  };

  const ensureMetadata = async (mint: string, signature?: string) => {
    const existing = metadataFetches.get(mint);
    if (existing) return await existing;
    const state = states.get(mint);
    if (!state) return;
    if (
      state.decimals != null &&
      state.supplyRaw != null &&
      (!signature || (state.quoteMint != null && state.quoteDecimals != null))
    )
      return;
    const pending = (async () => {
      try {
        if (state.decimals == null || state.supplyRaw == null) {
          const supply = await options.connection.getTokenSupply(
            new PublicKey(mint),
            "confirmed",
          );
          state.decimals = supply.value.decimals;
          if (state.supplyRaw == null)
            state.supplyRaw = BigInt(supply.value.amount);
          state.supplyRefreshedAtMs = Date.now();
        }
        if (
          signature &&
          (state.quoteMint == null || state.quoteDecimals == null)
        ) {
          const tx = await options.connection.getParsedTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 1,
          });
          if (tx) {
            const parsed = tx as ParsedTransactionWithMeta;
            const quote =
              launchLabQuoteFromTransaction(parsed, mint, state.pool) ??
              quoteFromTransaction(parsed, mint);
            if (quote) {
              state.quoteMint = quote.mint;
              state.quoteDecimals = quote.decimals;
              if (state.quoteDecimals == null) {
                const loaded = await options.connection.getTokenSupply(
                  new PublicKey(quote.mint),
                  "confirmed",
                );
                state.quoteDecimals = loaded.value.decimals;
              }
            }
          }
        }
      } catch (error) {
        status("trade-enrichment-error", {
          mint,
          signature: signature ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })().finally(() => {
      metadataFetches.delete(mint);
    });
    metadataFetches.set(mint, pending);
    await pending;
  };

  const emitPumpTrade = async (
    mint: string,
    signature: string,
    slot: number,
    decoded: Extract<PumpDecodedEvent, { kind: "trade" }>,
  ) => {
    if (decoded.mint !== mint) return;
    const current = states.get(mint);
    if (current) {
      current.quoteMint = decoded.quoteMint;
      current.quoteDecimals =
        current.quoteDecimals ?? quoteDecimals(decoded.quoteMint);
    }
    await ensureMetadata(mint, signature);
    const state = states.get(mint);
    if (!state || stopped || !subscriptions.has(mint)) return;
    const baseDecimals = state.decimals ?? 6;
    const qDecimals = state.quoteDecimals;
    await deliver({
      type: "trade",
      venue: "pump",
      signature,
      slot,
      atMs: decoded.atMs,
      mint,
      pool: state.pool,
      side: decoded.side,
      quoteMint: state.quoteMint,
      baseDecimals,
      quoteDecimals: qDecimals,
      baseRaw: decoded.baseRaw,
      quoteRaw: decoded.quoteRaw,
      marketState:
        qDecimals == null || state.supplyRaw == null
          ? null
          : {
              supplyRaw: state.supplyRaw,
              baseReserveRaw: decoded.virtualBaseRaw,
              quoteReserveRaw: decoded.virtualQuoteRaw,
            },
    });
  };

  const emitPumpSwapTrade = async (
    mint: string,
    signature: string,
    slot: number,
    decoded: Extract<PumpSwapDecodedEvent, { kind: "trade" }>,
  ) => {
    let identity: PumpSwapPoolIdentity;
    try {
      identity = await resolvePumpSwapPool(decoded.pool);
    } catch (error) {
      status("pumpswap-pool-resolution-error", {
        mint,
        pool: decoded.pool,
        signature,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (identity.baseMint !== mint) {
      status("pumpswap-pool-mismatch", {
        watchedMint: mint,
        pool: decoded.pool,
        poolBaseMint: identity.baseMint,
        signature,
      });
      return;
    }

    const state = states.get(mint);
    if (!state || stopped || !subscriptions.has(mint)) return;
    state.pool = identity.pool;
    state.decimals = identity.baseDecimals;
    state.quoteMint = identity.quoteMint;
    state.quoteDecimals = identity.quoteDecimals;
    // Event supply belongs to the event payload, not necessarily the watched
    // mint in a multi-pool transaction. Chain supply is the authority.
    try {
      await refreshWatchedSupply(state);
    } catch (error) {
      status("trade-enrichment-error", {
        mint,
        signature,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const effectiveQuoteRaw =
      decoded.virtualQuoteRaw == null
        ? null
        : decoded.poolQuoteRaw + decoded.virtualQuoteRaw;
    await deliver({
      type: "trade",
      venue: "pumpswap",
      signature,
      slot,
      atMs: decoded.atMs,
      mint,
      pool: decoded.pool,
      side: decoded.side,
      quoteMint: identity.quoteMint,
      baseDecimals: identity.baseDecimals,
      quoteDecimals: identity.quoteDecimals,
      baseRaw: decoded.baseRaw,
      quoteRaw: decoded.quoteRaw,
      marketState:
        state.supplyRaw == null || effectiveQuoteRaw == null
          ? null
          : {
              supplyRaw: state.supplyRaw,
              baseReserveRaw: decoded.poolBaseRaw,
              quoteReserveRaw: effectiveQuoteRaw,
            },
    });
  };

  const emitDbcTrade = async (mint: string, signature: string, slot: number, decoded: DbcTradeEvent) => {
    try {
      const market = await readDbcMarket(options.connection, decoded.pool);
      const poolState = market.virtualPool.poolState;
      if (poolState.baseMint.toBase58() !== mint || !poolState.config.equals(decoded.config)) {
        status("meteora-dbc-pool-mismatch", { mint, pool: decoded.pool.toBase58(), signature });
        return;
      }
      const state = states.get(mint);
      if (!state || stopped || !subscriptions.has(mint)) return;
      state.pool = decoded.pool.toBase58();
      state.quoteMint = market.config.quoteMint.toBase58();
      state.quoteDecimals = market.quoteDecimals;
      await refreshWatchedSupply(state);
      await deliver({ type: "trade", venue: "meteora-dbc", signature, slot, atMs: decoded.atMs,
        mint, pool: state.pool, side: decoded.sell ? "sell" : "buy",
        quoteMint: state.quoteMint, baseDecimals: market.baseDecimals, quoteDecimals: market.quoteDecimals,
        baseRaw: decoded.sell ? decoded.inputRaw : decoded.outputRaw,
        quoteRaw: decoded.sell ? decoded.outputRaw : decoded.inputRaw,
        marketState: { supplyRaw: state.supplyRaw!,
          baseReserveRaw: BigInt(poolState.baseReserve.toString()),
          quoteReserveRaw: BigInt(poolState.quoteReserve.toString()),
          priceQuotePerToken: dbcPrice(market, decoded.nextSqrtPrice) } });
    } catch (error) {
      status("meteora-dbc-enrichment-error", { mint, signature, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const emitDammV2Trade = async (mint: string, signature: string, slot: number, decoded: DammV2TradeEvent) => {
    try {
      const market = await readDammV2Market(options.connection, decoded.pool);
      const base = new PublicKey(mint);
      if (!market.state.tokenAMint.equals(base) && !market.state.tokenBMint.equals(base)) {
        status("meteora-damm-v2-pool-mismatch", { mint, pool: decoded.pool.toBase58(), signature });
        return;
      }
      const state = states.get(mint);
      if (!state || stopped || !subscriptions.has(mint)) return;
      const baseIsA = market.state.tokenAMint.equals(base);
      state.pool = decoded.pool.toBase58();
      state.quoteMint = (baseIsA ? market.state.tokenBMint : market.state.tokenAMint).toBase58();
      state.quoteDecimals = baseIsA ? market.decimalsB : market.decimalsA;
      await refreshWatchedSupply(state);
      const sell = baseIsA === decoded.aToB;
      await deliver({ type: "trade", venue: "meteora-damm-v2", signature, slot, atMs: decoded.atMs,
        mint, pool: state.pool, side: sell ? "sell" : "buy", quoteMint: state.quoteMint,
        baseDecimals: baseIsA ? market.decimalsA : market.decimalsB, quoteDecimals: state.quoteDecimals,
        baseRaw: sell ? decoded.inputRaw : decoded.outputRaw, quoteRaw: sell ? decoded.outputRaw : decoded.inputRaw,
        marketState: { supplyRaw: state.supplyRaw!,
          baseReserveRaw: baseIsA ? decoded.reserveA : decoded.reserveB,
          quoteReserveRaw: baseIsA ? decoded.reserveB : decoded.reserveA,
          priceQuotePerToken: dammV2Price(market, base, decoded.nextSqrtPrice) } });
    } catch (error) {
      status("meteora-damm-v2-enrichment-error", { mint, signature, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const emitLaunchLabTrade = async (
    mint: string,
    signature: string,
    slot: number,
    decoded: Extract<RaydiumLaunchLabDecodedEvent, { kind: "trade" }>,
  ) => {
    const current = states.get(mint);
    if (current) current.pool = decoded.pool;
    await ensureMetadata(mint, signature);
    const state = states.get(mint);
    if (!state || stopped || !subscriptions.has(mint)) return;
    await deliver({
      type: "trade",
      venue: "raydium-launchlab",
      signature,
      slot,
      atMs: Date.now(),
      mint,
      pool: decoded.pool,
      side: decoded.side,
      quoteMint: state.quoteMint,
      baseDecimals: state.decimals,
      quoteDecimals: state.quoteDecimals,
      baseRaw: decoded.baseRaw,
      quoteRaw: decoded.quoteRaw,
      marketState:
        state.decimals == null ||
        state.quoteDecimals == null ||
        state.supplyRaw == null
          ? null
          : {
              supplyRaw: state.supplyRaw,
              baseReserveRaw: decoded.virtualBaseRaw,
              quoteReserveRaw: decoded.virtualQuoteRaw,
            },
    });
  };

  const processMeteoraLogs = async <Event>(
    mint: string, logs: { logs: string[]; signature: string }, slot: number, venue: TradeVenue, program: PublicKey,
    decode: (connection: Connection, data: Buffer) => Event | null,
    fromTransaction: (connection: Connection, transaction: ParsedTransactionWithMeta) => Array<Event>,
    emit: (mint: string, signature: string, slot: number, event: Event) => Promise<void>,
  ) => {
    if (!venues.has(venue) || !logs.logs.some((line) => line.startsWith(`Program ${program.toBase58()} invoke`))) return;
    try {
      const decodedLogs = programDataEntries(logs.logs).filter((entry) => entry.programId === program.toBase58())
        .map((entry) => decode(options.connection, Buffer.from(entry.data))).filter((event): event is Event => event !== null);
      const transaction = decodedLogs.length ? null : await options.connection.getParsedTransaction(logs.signature, {
        commitment: "confirmed", maxSupportedTransactionVersion: 1,
      });
      const events = decodedLogs.length ? decodedLogs : transaction ? fromTransaction(options.connection, transaction) : [];
      if (!transaction && !decodedLogs.length) status(`${venue}-transaction-unavailable`, { mint, signature: logs.signature });
      for (const event of events) await emit(mint, logs.signature, slot, event);
    } catch (error) {
      status(`${venue}-event-error`, { mint, signature: logs.signature, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const onTokenLogs = (
    mint: string,
    logs: { err: unknown; logs: string[]; signature: string },
    slot: number,
  ) => {
    if (logs.err || stopped || !subscriptions.has(mint)) return;
    void processMeteoraLogs(mint, logs, slot, "meteora-dbc", DYNAMIC_BONDING_CURVE_PROGRAM_ID, decodeDbcTrade, dbcTradesFromTransaction, emitDbcTrade);
    void processMeteoraLogs(mint, logs, slot, "meteora-damm-v2", CP_AMM_PROGRAM_ID, decodeDammV2Trade, dammV2TradesFromTransaction, emitDammV2Trade);
    for (const entry of programDataEntries(logs.logs)) {
      if (entry.programId === CREATE_CPMM_POOL_PROGRAM.toBase58() && venues.has("raydium-cpmm")) {
        const decoded = decodeCpmmSwap(entry.data);
        if (!decoded || (decoded.inputMint !== mint && decoded.outputMint !== mint)) continue;
        void (async () => {
          try {
            const key = `${decoded.pool}:${mint}`;
            let pending = cpmmPools.get(key);
            if (!pending) { pending = resolveCurrentMarket(options.connection, mint, { pool: decoded.pool }); cpmmPools.set(key, pending); }
            const identity = await pending;
            if (!identity || identity.venue !== "raydium-cpmm") return;
            const isBuy = decoded.outputMint === mint;
            const quoteMint = isBuy ? decoded.inputMint : decoded.outputMint;
            if (identity.quoteMint !== quoteMint) return;
            const state = states.get(mint);
            if (!state || stopped) return;
            state.decimals = identity.baseDecimals; state.quoteDecimals = identity.quoteDecimals;
            state.quoteMint = identity.quoteMint; state.pool = identity.pool;
            await refreshWatchedSupply(state);
            if (decoded.inputReserveBefore <= 0n || decoded.outputReserveBefore <= 0n) return;
            // These are the protocol's fee-adjusted pre-swap reserves from this
            // exact event, never unrelated balances from a multi-pool transaction.
            await deliver({ type: "trade", venue: "raydium-cpmm", mint, pool: identity.pool,
              signature: logs.signature, slot, atMs: Date.now(), side: isBuy ? "buy" : "sell",
              quoteMint, baseDecimals: identity.baseDecimals, quoteDecimals: identity.quoteDecimals,
              baseRaw: isBuy ? decoded.outputRaw - decoded.outputTransferFee : decoded.inputRaw + decoded.inputTransferFee,
              quoteRaw: isBuy ? decoded.inputRaw + decoded.inputTransferFee : decoded.outputRaw - decoded.outputTransferFee,
              marketState: { supplyRaw: state.supplyRaw!, baseReserveRaw: isBuy ? decoded.outputReserveBefore : decoded.inputReserveBefore,
                quoteReserveRaw: isBuy ? decoded.inputReserveBefore : decoded.outputReserveBefore } });
          } catch (error) {
            cpmmPools.delete(`${decoded.pool}:${mint}`);
            status("raydium-cpmm-pool-resolution-error", { mint, pool: decoded.pool, error: error instanceof Error ? error.message : String(error) });
          }
        })();
        continue;
      }
      if (
        entry.programId === PUMP_PROGRAM_ID.toBase58() &&
        venues.has("pump")
      ) {
        const decoded = decodePumpProgramData(entry.data);
        if (!decoded) continue;
        if (decoded.kind === "launch" && decoded.mint === mint) {
          const state = states.get(mint);
          if (state) {
            state.decimals = decoded.decimals;
            state.supplyRaw = decoded.supplyRaw;
            state.quoteMint = decoded.quoteMint;
            state.quoteDecimals = quoteDecimals(decoded.quoteMint);
          }
          continue;
        }
        if (decoded.kind === "trade")
          void emitPumpTrade(mint, logs.signature, slot, decoded);
        continue;
      }
      if (
        entry.programId === PUMP_AMM_PROGRAM_ID.toBase58() &&
        venues.has("pumpswap")
      ) {
        const decoded = decodePumpSwapProgramData(entry.data);
        if (!decoded) continue;
        if (decoded.kind === "pool") {
          if (decoded.mint !== mint) continue;
          void (async () => {
            try {
              const identity = await resolvePumpSwapPool(decoded.pool);
              if (identity.baseMint !== mint) return;
              const state = states.get(mint);
              if (!state) return;
              state.decimals = identity.baseDecimals;
              state.quoteMint = identity.quoteMint;
              state.quoteDecimals = identity.quoteDecimals;
              state.pool = identity.pool;
              await refreshWatchedSupply(state);
            } catch (error) {
              status("pumpswap-pool-resolution-error", {
                mint,
                pool: decoded.pool,
                signature: logs.signature,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          continue;
        }
        void emitPumpSwapTrade(mint, logs.signature, slot, decoded);
        continue;
      }
      if (
        entry.programId === RAYDIUM_LAUNCHLAB_PROGRAM_ID.toBase58() &&
        venues.has("raydium-launchlab")
      ) {
        const decoded = decodeRaydiumLaunchLabProgramData(entry.data);
        if (!decoded) continue;
        if (decoded.kind === "pool") {
          const state = states.get(mint);
          if (state) state.pool = decoded.pool;
          void ensureMetadata(mint, logs.signature);
          continue;
        }
        void emitLaunchLabTrade(mint, logs.signature, slot, decoded);
      }
    }
  };

  const addTokens = async (value: string | readonly string[]) => {
    if (stopped) throw new Error("Trade subscription is closed");
    for (const mint of tokenList(value)) {
      if (subscriptions.has(mint)) continue;
      states.set(mint, {
        mint,
        decimals: null,
        supplyRaw: null,
        supplyRefreshedAtMs: 0,
        quoteMint: null,
        quoteDecimals: null,
        pool: null,
      });
      const id = options.connection.onLogs(
        new PublicKey(mint),
        (logs, context) => onTokenLogs(mint, logs, context.slot),
        commitment,
      );
      subscriptions.set(mint, id);
    }
    status("tokens-changed", {
      tokens: [...subscriptions.keys()],
      subscriptions: subscriptions.size,
      metadata: metadataMode,
    });
  };

  const removeTokens = async (value: string | readonly string[]) => {
    const removals: Promise<void>[] = [];
    for (const mint of tokenList(value)) {
      const id = subscriptions.get(mint);
      if (id == null) continue;
      subscriptions.delete(mint);
      states.delete(mint);
      pumpSwapPools.clear();
      cpmmPools.clear();
      removals.push(options.connection.removeOnLogsListener(id));
    }
    await Promise.allSettled(removals);
    status("tokens-changed", {
      tokens: [...subscriptions.keys()],
      subscriptions: subscriptions.size,
    });
  };

  const close = async () => {
    if (stopped) return;
    stopped = true;
    const ids = [...subscriptions.values()];
    subscriptions.clear();
    states.clear();
    await Promise.allSettled(
      ids.map((id) => options.connection.removeOnLogsListener(id)),
    );
    resolveClosed();
  };

  await addTokens(options.tokens);

  if (options.signal) {
    if (options.signal.aborted) await close();
    else
      options.signal.addEventListener("abort", () => void close(), {
        once: true,
      });
  }

  return {
    addTokens,
    removeTokens,
    hasToken(token) {
      try {
        return subscriptions.has(new PublicKey(token).toBase58());
      } catch {
        return false;
      }
    },
    listTokens() {
      return [...subscriptions.keys()];
    },
    close,
    closed,
  };
}

function quoteSolLoader(
  connection: Connection,
  status: (event: string, data?: Record<string, unknown>) => void,
  maxAgeMs = 15_000,
) {
  const cache = new Map<string, { value: number | null; atMs: number }>();
  const pending = new Map<string, Promise<number | null>>();
  return async (mint: string, decimals: number): Promise<number | null> => {
    if (mint === WRAPPED_SOL_MINT) return 1;
    const now = Date.now();
    const cached = cache.get(mint);
    if (cached && now - cached.atMs < maxAgeMs) return cached.value;
    const active = pending.get(mint);
    if (active) return await active;
    const request = (async () => {
      try {
        const venue = new PumpSwapVenue();
        const inspected = await venue.inspectToken(connection, new PublicKey(mint));
        if (inspected?.quoteMint === WRAPPED_SOL_MINT) {
          const token = { ...inspected, mint } as TokenRow;
          const market = await venue.resolveMarket({ connection, token, user: PublicKey.default });
          if (market) {
            const price = (await venue.price({ connection, token, user: PublicKey.default }, market)).priceQuotePerToken;
            if (Number.isFinite(price) && price > 0) {
              cache.set(mint, { value: price, atMs: Date.now() });
              return price;
            }
          }
        }
      } catch {
        // If no supported direct SOL pool is available, try the verified
        // executable quote route below. Unavailability remains null.
      }
      try {
        // Quote a modest notional to avoid a zero-lamport route while limiting
        // price impact. This is an executable-route conversion, not an inferred
        // transaction-balance ratio.
        const units = 100n;
        const amountRaw = units * 10n ** BigInt(decimals);
        const quote = await quoteJupiterSwap({
          inputMint: mint,
          outputMint: WRAPPED_SOL_MINT,
          amountRaw,
        });
        const value = Number(quote.outAmountRaw) / 1e9 / Number(units);
        const resolved = Number.isFinite(value) && value > 0 ? value : null;
        cache.set(mint, { value: resolved, atMs: Date.now() });
        return resolved;
      } catch (error) {
        cache.set(mint, { value: null, atMs: Date.now() });
        status("quote-sol-conversion-unavailable", {
          quoteMint: mint,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })().finally(() => pending.delete(mint));
    pending.set(mint, request);
    return await request;
  };
}

export async function subscribeTrades(options: {
  connection: Connection;
  tokens: readonly string[];
  venues?: readonly TradeVenue[];
  commitment?: Commitment;
  metadata?: TokenMetadataMode;
  signal?: AbortSignal;
  solUsd?: number | (() => number | Promise<number>);
  solUsdRefreshMs?: number;
  /** Override quote-token conversion; null keeps quote prices available without SOL pricing. */
  quoteSol?: (mint: string, decimals: number) => Promise<number | null>;
  onTrade: (event: TradeEvent) => void | Promise<void>;
  onStatus?: (event: string, data?: Record<string, unknown>) => void;
}): Promise<TradeSubscription> {
  const status = (event: string, data?: Record<string, unknown>) => {
    try {
      options.onStatus?.(event, data);
    } catch {}
  };
  const getSolUsd = solUsdLoader(
    options.solUsd,
    Math.max(1_000, Math.trunc(options.solUsdRefreshMs ?? 15_000)),
    status,
  );
  const getQuoteSol = options.quoteSol ?? quoteSolLoader(options.connection, status);
  return await subscribeTradeStream({
    connection: options.connection,
    tokens: options.tokens,
    venues: options.venues,
    commitment: options.commitment,
    metadata: options.metadata,
    signal: options.signal,
    onStatus: options.onStatus,
    onTrade: async (internal) => {
      const needsSolUsd = internal.quoteMint != null;
      const solUsd = needsSolUsd ? await getSolUsd() : null;
      const quoteSolPerToken =
        internal.quoteMint != null &&
        internal.quoteDecimals != null &&
        internal.quoteMint !== WRAPPED_SOL_MINT &&
        internal.quoteMint !== USDC_MINT
          ? await getQuoteSol(internal.quoteMint, internal.quoteDecimals)
          : null;
      const market = tradeMarketFromTradeEvent(
        internal,
        solUsd,
        quoteSolPerToken,
      );
      if (!market) {
        status("trade-market-incomplete", {
          venue: internal.venue,
          mint: internal.mint,
          signature: internal.signature,
        });
        return;
      }
      const event: TradeEvent = {
        type: "trade",
        venue: internal.venue,
        signature: internal.signature,
        slot: internal.slot,
        atMs: internal.atMs,
        mint: internal.mint,
        pool: internal.pool,
        side: internal.side,
        baseRaw: internal.baseRaw,
        quoteRaw: internal.quoteRaw,
        market,
        metadata: internal.metadata,
      };
      try {
        await options.onTrade(event);
      } catch (error) {
        callbackError(status, event, error);
      }
    },
  });
}
