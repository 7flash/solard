import { configure, createMeasure } from "measure-fn";
import bs58 from "bs58";
import { bondingCurvePda } from "@solard/core";
import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import type {
  PriceFeedCommand,
  PriceFeedLaunch,
  PriceFeedMessage,
  PriceFeedPrice,
  PriceFeedVenue,
} from "./price-feed-protocol.ts";

type Flags = Map<string, string>;
type Emit = (value: string) => void;
type Client = {
  mints: Set<string>;
  launches: boolean;
  allPrices: boolean;
};
type MintState = {
  mint: string;
  venue: "pump" | "raydium-launchlab";
  decimals: number;
  supplyUi: number;
  quoteMint: string | null;
  quoteDecimals: number;
  pool: string | null;
  name: string | null;
  symbol: string | null;
  isMayhemMode: boolean | null;
  lastSeenAtMs: number;
};
type PoolState = {
  pool: string;
  mint: string;
  baseDecimals: number;
  quoteMint: string;
  quoteDecimals: number;
};

const PUMP_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
);
const PUMP_AMM_PROGRAM = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
);
const LAUNCHLAB_PROGRAM = new PublicKey(
  "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
);
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEFAULT_PUBKEY = "11111111111111111111111111111111";
const LAMPORTS_PER_SOL = 1_000_000_000;
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

function flag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function numberFlag(flags: Flags, key: string, fallback: number): number {
  const value = flag(flags, key);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${value}`);
  return parsed;
}

function rpcUrl(flags: Flags): string {
  const value =
    flag(flags, "rpc") ??
    process.env.RPC_ENDPOINT?.trim() ??
    process.env.SOLANA_RPC_URL?.trim() ??
    process.env.HELIUS_RPC_URL?.trim();
  if (!value)
    throw new Error(
      "feed serve requires RPC_ENDPOINT, SOLANA_RPC_URL, HELIUS_RPC_URL, or --rpc <url>",
    );
  return value;
}

function feedUrl(flags: Flags): { host: string; port: number } {
  const host = flag(flags, "host") ?? "127.0.0.1";
  const port = Math.trunc(numberFlag(flags, "port", 8788));
  if (!(port > 0 && port <= 65535)) throw new Error("--port must be 1..65535");
  return { host, port };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class RpcPacer {
  private tail: Promise<unknown> = Promise.resolve();
  private nextAt = 0;
  private count = 0;
  constructor(readonly rps: number) {}
  get queued(): number {
    return this.count;
  }
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.count += 1;
    const step = Math.ceil(1_000 / this.rps);
    const run = async () => {
      const wait = Math.max(0, this.nextAt - Date.now());
      if (wait) await sleep(wait);
      this.nextAt = Math.max(this.nextAt, Date.now()) + step;
      try {
        return await fn();
      } finally {
        this.count -= 1;
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

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
  skip(n: number): void {
    if (this.remaining < n) throw new Error("truncated event");
    this.offset += n;
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

function dataEvents(logs: readonly string[]): Buffer[] {
  const rows: Buffer[] = [];
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

function starts(data: Buffer, discriminator: Buffer): boolean {
  return (
    data.length >= discriminator.length &&
    data.subarray(0, discriminator.length).equals(discriminator)
  );
}

function pumpCreate(data: Buffer): PriceFeedLaunch | null {
  if (!starts(data, PUMP_CREATE_EVENT)) return null;
  try {
    const c = new Cursor(data, 8);
    const name = c.string();
    const symbol = c.string();
    c.string();
    const mint = c.pubkey();
    c.pubkey();
    c.pubkey();
    c.pubkey();
    const timestamp = Number(c.i64()) * 1_000;
    c.u64();
    c.u64();
    c.u64();
    const supplyRaw = c.u64();
    c.pubkey();
    const isMayhemMode = c.bool();
    if (c.remaining > 0) c.bool();
    const rawQuoteMint = c.remaining >= 32 ? c.pubkey() : WSOL_MINT;
    const quoteMint =
      rawQuoteMint === DEFAULT_PUBKEY ? WSOL_MINT : rawQuoteMint;
    const decimals = 6;
    return {
      type: "launch",
      atMs: timestamp > 0 ? timestamp : Date.now(),
      signature: null,
      slot: null,
      mint,
      venue: "pump",
      decimals,
      supplyUi: Number(supplyRaw) / 10 ** decimals,
      quoteMint,
      pool: null,
      name: name || null,
      symbol: symbol || null,
      isMayhemMode,
    };
  } catch {
    return null;
  }
}

function pumpTrade(data: Buffer): {
  mint: string;
  atMs: number;
  virtualSol: bigint;
  virtualToken: bigint;
} | null {
  if (!starts(data, PUMP_TRADE_EVENT)) return null;
  try {
    const c = new Cursor(data, 8);
    const mint = c.pubkey();
    c.u64();
    c.u64();
    c.bool();
    c.pubkey();
    const atMs = Number(c.i64()) * 1_000;
    const virtualSol = c.u64();
    const virtualToken = c.u64();
    if (virtualSol <= 0n || virtualToken <= 0n) return null;
    return {
      mint,
      atMs: atMs > 0 ? atMs : Date.now(),
      virtualSol,
      virtualToken,
    };
  } catch {
    return null;
  }
}

function pumpSwapCreate(data: Buffer): (PoolState & { atMs: number }) | null {
  if (!starts(data, PUMPSWAP_CREATE_EVENT)) return null;
  try {
    const c = new Cursor(data, 8);
    const atMs = Number(c.i64()) * 1_000;
    c.u16();
    c.pubkey();
    const mint = c.pubkey();
    const quoteMint = c.pubkey();
    const baseDecimals = c.u8();
    const quoteDecimals = c.u8();
    for (let i = 0; i < 7; i += 1) c.u64();
    c.u8();
    const pool = c.pubkey();
    return { pool, mint, baseDecimals, quoteMint, quoteDecimals, atMs };
  } catch {
    return null;
  }
}

function pumpSwapTrade(data: Buffer): {
  pool: string;
  atMs: number;
  baseRaw: bigint;
  quoteRaw: bigint;
} | null {
  const buy = starts(data, PUMPSWAP_BUY_EVENT);
  const sell = starts(data, PUMPSWAP_SELL_EVENT);
  if (!buy && !sell) return null;
  try {
    const c = new Cursor(data, 8);
    const atMs = Number(c.i64()) * 1_000;
    c.u64();
    c.u64();
    c.u64();
    c.u64();
    const baseRaw = c.u64();
    const quoteRaw = c.u64();
    c.u64();
    c.u64();
    c.u64();
    c.u64();
    c.u64();
    c.u64();
    c.u64();
    const pool = c.pubkey();
    return { pool, atMs: atMs > 0 ? atMs : Date.now(), baseRaw, quoteRaw };
  } catch {
    return null;
  }
}

function launchLabPoolCreate(data: Buffer): string | null {
  if (!starts(data, LAUNCHLAB_CREATE_EVENT)) return null;
  try {
    return new Cursor(data, 8).pubkey();
  } catch {
    return null;
  }
}

function launchLabTrade(data: Buffer): {
  pool: string;
  virtualBase: bigint;
  virtualQuote: bigint;
} | null {
  if (!starts(data, LAUNCHLAB_TRADE_EVENT)) return null;
  try {
    const c = new Cursor(data, 8);
    const pool = c.pubkey();
    c.u64();
    const virtualBase = c.u64();
    const virtualQuote = c.u64();
    return { pool, virtualBase, virtualQuote };
  } catch {
    return null;
  }
}

function keyText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof (value as any).toBase58 === "function")
    return (value as any).toBase58();
  if (value && typeof (value as any).pubkey?.toBase58 === "function")
    return (value as any).pubkey.toBase58();
  if (value && typeof (value as any).pubkey === "string")
    return (value as any).pubkey;
  return null;
}

function instructions(tx: ParsedTransactionWithMeta): any[] {
  const outer = ((tx.transaction.message as any).instructions ?? []) as any[];
  const inner = (tx.meta?.innerInstructions ?? []).flatMap(
    (group: any) => group.instructions ?? [],
  );
  return [...outer, ...inner];
}

function initializedMints(tx: ParsedTransactionWithMeta): string[] {
  const out = new Set<string>();
  for (const ix of instructions(tx)) {
    const parsed = (ix as any)?.parsed;
    const type = String(parsed?.type ?? "").toLowerCase();
    if (type !== "initializemint" && type !== "initializemint2") continue;
    const mint =
      keyText(parsed?.info?.mint) ?? String(parsed?.info?.mint ?? "");
    if (mint && mint !== WSOL_MINT && mint !== USDC_MINT) out.add(mint);
  }
  return [...out];
}

function tokenBalances(rows: readonly any[] | null | undefined) {
  return (rows ?? []).map((row) => ({
    accountIndex: Number(row.accountIndex),
    mint: String(row.mint ?? ""),
    owner: row.owner ? String(row.owner) : null,
    raw: (() => {
      try {
        return BigInt(String(row?.uiTokenAmount?.amount ?? "0"));
      } catch {
        return 0n;
      }
    })(),
    decimals: Number(row?.uiTokenAmount?.decimals ?? 0),
  }));
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
  const raw = [...byAccount.values()].reduce((sum, value) => sum + value, 0n);
  const supplyUi = Number(raw) / 10 ** decimals;
  return Number.isFinite(supplyUi) && supplyUi > 0
    ? { decimals, supplyUi }
    : null;
}

function signerKeys(tx: ParsedTransactionWithMeta): Set<string> {
  return new Set(
    (((tx.transaction.message as any).accountKeys ?? []) as any[])
      .filter((row) => row && typeof row === "object" && row.signer === true)
      .map((row) => keyText(row))
      .filter((row): row is string => Boolean(row)),
  );
}

function accountKeys(tx: ParsedTransactionWithMeta): string[] {
  return (((tx.transaction.message as any).accountKeys ?? []) as any[])
    .map((row) => keyText(row))
    .filter((row): row is string => Boolean(row));
}

function ownerDelta(
  tx: ParsedTransactionWithMeta,
  mint: string,
  owner: string,
): bigint {
  const pre = tokenBalances(tx.meta?.preTokenBalances);
  const post = tokenBalances(tx.meta?.postTokenBalances);
  const indexes = new Set<number>();
  for (const row of [...pre, ...post])
    if (row.mint === mint && row.owner === owner) indexes.add(row.accountIndex);
  let total = 0n;
  for (const index of indexes) {
    const before =
      pre.find((row) => row.accountIndex === index && row.mint === mint)?.raw ??
      0n;
    const after =
      post.find((row) => row.accountIndex === index && row.mint === mint)
        ?.raw ?? 0n;
    total += after - before;
  }
  return total;
}

function tokenAccountRentDelta(
  tx: ParsedTransactionWithMeta,
  owner: string,
): bigint {
  if (!tx.meta) return 0n;
  const pre = tokenBalances(tx.meta.preTokenBalances);
  const post = tokenBalances(tx.meta.postTokenBalances);
  const indices = new Set(
    [...pre, ...post]
      .filter((row) => row.owner === owner)
      .map((row) => row.accountIndex),
  );
  let total = 0n;
  for (const index of indices) {
    const before = BigInt(Math.trunc(Number(tx.meta.preBalances[index] ?? 0)));
    const after = BigInt(Math.trunc(Number(tx.meta.postBalances[index] ?? 0)));
    const pairPre = pre.find((row) => row.accountIndex === index);
    const pairPost = post.find((row) => row.accountIndex === index);
    let delta = after - before;
    if ((pairPost?.mint ?? pairPre?.mint) === WSOL_MINT)
      delta -= (pairPost?.raw ?? 0n) - (pairPre?.raw ?? 0n);
    total += delta;
  }
  return total;
}

function genericPrice(
  tx: ParsedTransactionWithMeta,
  mint: string,
  decimals: number,
): { atMs: number; priceSol: number | null; priceUsd: number | null } | null {
  if (!tx.meta || tx.meta.err) return null;
  const pre = tokenBalances(tx.meta.preTokenBalances);
  const post = tokenBalances(tx.meta.postTokenBalances);
  const signers = signerKeys(tx);
  const owners = new Set<string>();
  for (const row of [...pre, ...post])
    if (row.mint === mint && row.owner && signers.has(row.owner))
      owners.add(row.owner);
  const keys = accountKeys(tx);
  for (const owner of owners) {
    const tokenDelta = ownerDelta(tx, mint, owner);
    if (tokenDelta === 0n) continue;
    const tokenUi = Math.abs(Number(tokenDelta)) / 10 ** decimals;
    if (!(tokenUi > 0)) continue;
    const ownerIndex = keys.indexOf(owner);
    if (ownerIndex >= 0) {
      const before = BigInt(
        Math.trunc(Number(tx.meta.preBalances[ownerIndex] ?? 0)),
      );
      const after = BigInt(
        Math.trunc(Number(tx.meta.postBalances[ownerIndex] ?? 0)),
      );
      const fee = keys[0] === owner ? BigInt(tx.meta.fee ?? 0) : 0n;
      const rent = tokenAccountRentDelta(tx, owner);
      const wsol = ownerDelta(tx, WSOL_MINT, owner);
      const delta = after - before + fee + rent + wsol;
      const solUi = Math.abs(Number(delta)) / LAMPORTS_PER_SOL;
      if (solUi > 0)
        return {
          atMs: (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1_000,
          priceSol: solUi / tokenUi,
          priceUsd: null,
        };
    }
    const usdc = ownerDelta(tx, USDC_MINT, owner);
    const usdcUi = Math.abs(Number(usdc)) / 1_000_000;
    if (usdcUi > 0)
      return {
        atMs: (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1_000,
        priceSol: null,
        priceUsd: usdcUi / tokenUi,
      };
  }
  return null;
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadSolUsd(): Promise<number> {
  try {
    const raw = await fetchJson(
      "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    );
    const value = Number(raw?.data?.amount);
    if (Number.isFinite(value) && value > 0) return value;
  } catch {}
  const raw = await fetchJson(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  );
  const value = Number(raw?.solana?.usd);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("SOL/USD unavailable");
  return value;
}

export async function runPriceFeedServerCommand(args: {
  flags: Flags;
  emit: Emit;
}): Promise<void> {
  configure({
    silent: false,
    logger(_event: unknown, next?: () => void) {
      next?.();
    },
  });
  const m = createMeasure("slrd:feed", { maxResultLength: 1600 });
  const report = <T extends Record<string, unknown>>(
    label: string,
    value: T,
  ): T =>
    m.sync({ start: () => label, end: (result: T) => result }, () => value);
  const { host, port } = feedUrl(args.flags);
  const connection = new Connection(rpcUrl(args.flags), "confirmed");
  const hardRps = Math.max(1, Math.trunc(numberFlag(args.flags, "rpc-rps", 5)));
  const readRps = Math.max(
    1,
    Math.min(hardRps, Math.trunc(numberFlag(args.flags, "rpc-read-rps", 2))),
  );
  const pacer = new RpcPacer(readRps);
  const includeMayhem = args.flags.has("include-mayhem");
  const maxFallbackSubscriptions = Math.max(
    1,
    Math.trunc(numberFlag(args.flags, "max-fallback-subs", 200)),
  );
  const clients = new Map<any, Client>();
  const mints = new Map<string, MintState>();
  const pools = new Map<string, PoolState>();
  const launchesByMint = new Map<string, PriceFeedLaunch>();
  const latest = new Map<string, PriceFeedPrice>();
  const fallbackSubs = new Map<string, { id: number; refs: number }>();
  const fallbackOps = new Map<string, Promise<void>>();
  const pendingFallback = new Map<string, string>();
  const createFetches = new Set<string>();
  const programSubs: number[] = [];
  let launches = 0;
  let prices = 0;
  let clientConnections = 0;
  let coalescedFallback = 0;
  let rpcErrors = 0;
  let stopped = false;
  let solUsd: number | null = null;
  let solUsdAt = 0;
  let solUsdRetryAt = 0;
  let solUsdFailures = 0;
  let solUsdPromise: Promise<number | null> | null = null;

  const refreshSolUsd = async () => {
    const now = Date.now();
    if (solUsd != null && now - solUsdAt < 60_000) return solUsd;
    if (now < solUsdRetryAt) return solUsd;
    if (solUsdPromise) return await solUsdPromise;
    solUsdPromise = (async () => {
      try {
        solUsd = await loadSolUsd();
        solUsdAt = Date.now();
        solUsdRetryAt = 0;
        solUsdFailures = 0;
      } catch (error) {
        solUsdFailures += 1;
        const retry = Math.min(
          300_000,
          15_000 * 2 ** Math.min(5, solUsdFailures - 1),
        );
        solUsdRetryAt = Date.now() + retry;
        report("sol/usd unavailable", {
          error: errorText(error),
          failures: solUsdFailures,
          retryInMs: retry,
          usingCached: solUsd != null,
        });
      } finally {
        solUsdPromise = null;
      }
      return solUsd;
    })();
    return await solUsdPromise;
  };

  const send = (ws: any, value: PriceFeedMessage) => {
    try {
      ws.send(JSON.stringify(value));
    } catch {}
  };

  const broadcast = (value: PriceFeedMessage) => {
    for (const [ws, client] of clients) {
      if (value.type === "launch") {
        if (client.launches) send(ws, value);
      } else if (value.type === "price") {
        if (client.allPrices || client.mints.has(value.mint)) send(ws, value);
      } else send(ws, value);
    }
  };

  const emitLaunch = (value: PriceFeedLaunch) => {
    if (value.isMayhemMode === true && !includeMayhem) return;
    const existing = mints.get(value.mint);
    mints.set(value.mint, {
      ...(existing ?? {}),
      mint: value.mint,
      venue: value.venue,
      decimals: value.decimals,
      supplyUi: value.supplyUi,
      quoteMint: value.quoteMint,
      quoteDecimals: value.quoteMint === USDC_MINT ? 6 : 9,
      pool: value.pool ?? existing?.pool ?? null,
      name: value.name ?? existing?.name ?? null,
      symbol: value.symbol ?? existing?.symbol ?? null,
      isMayhemMode: value.isMayhemMode,
      lastSeenAtMs: value.atMs,
    });
    launchesByMint.set(value.mint, value);
    launches += 1;
    broadcast(value);
  };

  const emitPrice = async (
    input: Omit<PriceFeedPrice, "priceUsd" | "marketCapUsd"> & {
      priceUsd?: number | null;
      marketCapUsd?: number | null;
    },
  ) => {
    const state = mints.get(input.mint);
    if (state?.isMayhemMode === true && !includeMayhem) return;
    const usd =
      input.priceUsd ??
      (input.priceSol != null
        ? (await refreshSolUsd()) != null
          ? input.priceSol * solUsd!
          : null
        : null);
    const marketCapUsd =
      input.marketCapUsd ??
      (usd != null && state?.supplyUi ? usd * state.supplyUi : null);
    const value: PriceFeedPrice = { ...input, priceUsd: usd, marketCapUsd };
    latest.set(value.mint, value);
    if (state) state.lastSeenAtMs = Math.max(state.lastSeenAtMs, value.atMs);
    prices += 1;
    broadcast(value);
  };

  const bootstrapMint = async (mint: string) => {
    if (mints.has(mint)) return;
    try {
      const key = new PublicKey(mint);
      const supply = await pacer.run(() =>
        connection.getTokenSupply(key, "confirmed"),
      );
      const curve = await pacer.run(() =>
        connection.getAccountInfo(bondingCurvePda(key), "confirmed"),
      );
      const supplyUi = Number(supply.value.uiAmountString ?? "0");
      const state: MintState = {
        mint,
        venue: "pump",
        decimals: supply.value.decimals,
        supplyUi,
        quoteMint: WSOL_MINT,
        quoteDecimals: 9,
        pool: null,
        name: null,
        symbol: null,
        isMayhemMode: null,
        lastSeenAtMs: Date.now(),
      };
      mints.set(mint, state);
      if (
        curve &&
        curve.owner.equals(PUMP_PROGRAM) &&
        curve.data.length >= 49
      ) {
        const data = Buffer.from(curve.data);
        const base = data.readBigUInt64LE(8);
        const quote = data.readBigUInt64LE(16);
        if (base > 0n && quote > 0n) {
          const priceSol =
            Number(quote) /
            LAMPORTS_PER_SOL /
            (Number(base) / 10 ** state.decimals);
          await emitPrice({
            type: "price",
            atMs: Date.now(),
            signature: null,
            slot: null,
            mint,
            venue: "pump",
            priceSol,
            source: "bootstrap-curve",
          });
        }
      }
    } catch (error) {
      report("mint bootstrap error", { mint, error: errorText(error) });
    }
  };

  const refreshFallbackRef = async (mint: string) => {
    let refs = 0;
    for (const client of clients.values())
      if (client.mints.has(mint)) refs += 1;
    const existing = fallbackSubs.get(mint);
    if (refs === 0) {
      if (existing) {
        fallbackSubs.delete(mint);
        await connection
          .removeOnLogsListener(existing.id)
          .catch(() => undefined);
      }
      return;
    }
    if (existing) {
      existing.refs = refs;
      return;
    }
    if (fallbackSubs.size >= maxFallbackSubscriptions) {
      report("fallback subscription budget reached", {
        mint,
        active: fallbackSubs.size,
        limit: maxFallbackSubscriptions,
      });
      return;
    }
    await bootstrapMint(mint);
    const id = connection.onLogs(
      new PublicKey(mint),
      (event) => {
        if (event.err) return;
        if (
          pendingFallback.has(mint) &&
          pendingFallback.get(mint) !== event.signature
        )
          coalescedFallback += 1;
        pendingFallback.set(mint, event.signature);
      },
      "processed",
    );
    fallbackSubs.set(mint, { id, refs });
  };

  const queueFallbackRefresh = (mint: string) => {
    const previous = fallbackOps.get(mint) ?? Promise.resolve();
    const next = previous
      .then(() => refreshFallbackRef(mint))
      .catch((error) =>
        report("fallback subscription error", {
          mint,
          error: errorText(error),
        }),
      )
      .then(() => undefined);
    fallbackOps.set(mint, next);
    void next.finally(() => {
      if (fallbackOps.get(mint) === next) fallbackOps.delete(mint);
    });
  };

  const applyClientCommand = (ws: any, command: PriceFeedCommand) => {
    const client = clients.get(ws);
    if (!client) return;
    if (command.op === "ping") {
      send(ws, { type: "status", atMs: Date.now(), event: "pong" });
      return;
    }
    const rows = (command.mints ?? []).filter(Boolean);
    if (command.op === "subscribe") {
      if (command.launches === true && !client.launches) {
        client.launches = true;
        for (const launch of launchesByMint.values()) send(ws, launch);
      }
      if (command.allPrices === true && !client.allPrices) {
        client.allPrices = true;
        for (const value of latest.values()) send(ws, value);
      }
      for (const mint of rows) client.mints.add(mint);
      for (const mint of rows) {
        const cached = latest.get(mint);
        if (cached) send(ws, cached);
        queueFallbackRefresh(mint);
      }
      return;
    }
    for (const mint of rows) {
      client.mints.delete(mint);
      queueFallbackRefresh(mint);
    }
  };

  const server = Bun.serve({
    hostname: host,
    port,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        const ok = server.upgrade(request);
        return ok ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          clients: clients.size,
          programSubscriptions: programSubs.length,
          fallbackSubscriptions: fallbackSubs.size,
          knownMints: mints.size,
          cachedLaunches: launchesByMint.size,
          latestPrices: latest.size,
          rpcQueue: pacer.queued,
        });
      }
      return new Response("Solard price feed\n", { status: 200 });
    },
    websocket: {
      open(ws) {
        clients.set(ws, {
          mints: new Set(),
          launches: false,
          allPrices: false,
        });
        clientConnections += 1;
        send(ws, {
          type: "status",
          atMs: Date.now(),
          event: "ready",
          data: { programSubscriptions: programSubs.length },
        });
      },
      message(ws, message) {
        try {
          applyClientCommand(
            ws,
            JSON.parse(String(message)) as PriceFeedCommand,
          );
        } catch (error) {
          send(ws, {
            type: "status",
            atMs: Date.now(),
            event: "client-error",
            data: { error: errorText(error) },
          });
        }
      },
      close(ws) {
        const client = clients.get(ws);
        clients.delete(ws);
        if (client) for (const mint of client.mints) queueFallbackRefresh(mint);
      },
    },
  });

  const createFromLaunchLab = async (
    signature: string,
    pool: string,
    slot: number | null,
  ) => {
    if (createFetches.has(signature)) return;
    createFetches.add(signature);
    try {
      const tx = await pacer.run(() =>
        connection.getParsedTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 1,
        } as any),
      );
      if (!tx) return;
      const candidates = initializedMints(tx as ParsedTransactionWithMeta);
      const mint = candidates[0];
      if (!mint) return;
      let supply = supplyFromTransaction(tx as ParsedTransactionWithMeta, mint);
      if (!supply) {
        const loaded = await pacer.run(() =>
          connection.getTokenSupply(new PublicKey(mint), "confirmed"),
        );
        const supplyUi = Number(loaded.value.uiAmountString ?? "0");
        supply = { decimals: loaded.value.decimals, supplyUi };
      }
      const balances = tokenBalances(
        (tx as ParsedTransactionWithMeta).meta?.postTokenBalances,
      );
      const quoteMint = balances.some((row) => row.mint === WSOL_MINT)
        ? WSOL_MINT
        : balances.some((row) => row.mint === USDC_MINT)
          ? USDC_MINT
          : WSOL_MINT;
      pools.set(pool, {
        pool,
        mint,
        baseDecimals: supply.decimals,
        quoteMint,
        quoteDecimals: quoteMint === USDC_MINT ? 6 : 9,
      });
      emitLaunch({
        type: "launch",
        atMs:
          ((tx as ParsedTransactionWithMeta).blockTime ??
            Math.floor(Date.now() / 1000)) * 1_000,
        signature,
        slot: slot ?? (tx as ParsedTransactionWithMeta).slot,
        mint,
        venue: "raydium-launchlab",
        decimals: supply.decimals,
        supplyUi: supply.supplyUi,
        quoteMint,
        pool,
        name: null,
        symbol: null,
        isMayhemMode: false,
      });
    } catch (error) {
      rpcErrors += 1;
      report("launchlab create enrichment error", {
        signature,
        pool,
        error: errorText(error),
      });
    } finally {
      createFetches.delete(signature);
    }
  };

  const pumpSub = connection.onLogs(
    PUMP_PROGRAM,
    (event, context) => {
      if (event.err) return;
      for (const data of dataEvents(event.logs)) {
        const created = pumpCreate(data);
        if (created) {
          created.signature = event.signature;
          created.slot = context.slot;
          emitLaunch(created);
          continue;
        }
        const trade = pumpTrade(data);
        if (!trade) continue;
        const state = mints.get(trade.mint);
        if (!state || state.isMayhemMode === true) continue;
        if (state.quoteMint && state.quoteMint !== WSOL_MINT) continue;
        const virtualTokens = Number(trade.virtualToken) / 10 ** state.decimals;
        const virtualSol = Number(trade.virtualSol) / LAMPORTS_PER_SOL;
        const priceSol = virtualTokens > 0 ? virtualSol / virtualTokens : 0;
        if (!(priceSol > 0 && Number.isFinite(priceSol))) continue;
        void emitPrice({
          type: "price",
          atMs: trade.atMs,
          signature: event.signature,
          slot: context.slot,
          mint: trade.mint,
          venue: "pump",
          priceSol,
          source: "pump-trade-event",
        });
      }
    },
    "processed",
  );
  programSubs.push(pumpSub);

  const pumpSwapSub = connection.onLogs(
    PUMP_AMM_PROGRAM,
    (event, context) => {
      if (event.err) return;
      for (const data of dataEvents(event.logs)) {
        const created = pumpSwapCreate(data);
        if (created) {
          pools.set(created.pool, created);
          const state = mints.get(created.mint);
          if (state) {
            state.pool = created.pool;
            state.quoteMint = created.quoteMint;
            state.quoteDecimals = created.quoteDecimals;
          }
          continue;
        }
        const trade = pumpSwapTrade(data);
        if (!trade) continue;
        const pool = pools.get(trade.pool);
        if (!pool || trade.baseRaw <= 0n || trade.quoteRaw <= 0n) continue;
        const priceQuote =
          Number(trade.quoteRaw) /
          10 ** pool.quoteDecimals /
          (Number(trade.baseRaw) / 10 ** pool.baseDecimals);
        if (!(priceQuote > 0 && Number.isFinite(priceQuote))) continue;
        void emitPrice({
          type: "price",
          atMs: trade.atMs,
          signature: event.signature,
          slot: context.slot,
          mint: pool.mint,
          venue: "pumpswap",
          priceSol: pool.quoteMint === WSOL_MINT ? priceQuote : null,
          priceUsd: pool.quoteMint === USDC_MINT ? priceQuote : null,
          source: "pumpswap-event",
        });
      }
    },
    "processed",
  );
  programSubs.push(pumpSwapSub);

  const launchLabSub = connection.onLogs(
    LAUNCHLAB_PROGRAM,
    (event, context) => {
      if (event.err) return;
      for (const data of dataEvents(event.logs)) {
        const createdPool = launchLabPoolCreate(data);
        if (createdPool) {
          void createFromLaunchLab(event.signature, createdPool, context.slot);
          continue;
        }
        const trade = launchLabTrade(data);
        if (!trade) continue;
        const pool = pools.get(trade.pool);
        if (!pool || trade.virtualBase <= 0n || trade.virtualQuote <= 0n)
          continue;
        const priceQuote =
          Number(trade.virtualQuote) /
          10 ** pool.quoteDecimals /
          (Number(trade.virtualBase) / 10 ** pool.baseDecimals);
        if (!(priceQuote > 0 && Number.isFinite(priceQuote))) continue;
        void emitPrice({
          type: "price",
          atMs: Date.now(),
          signature: event.signature,
          slot: context.slot,
          mint: pool.mint,
          venue: "raydium-launchlab",
          priceSol: pool.quoteMint === WSOL_MINT ? priceQuote : null,
          priceUsd: pool.quoteMint === USDC_MINT ? priceQuote : null,
          source: "launchlab-trade-event",
        });
      }
    },
    "processed",
  );
  programSubs.push(launchLabSub);

  const fallbackLoop = async () => {
    while (!stopped) {
      const entry = pendingFallback.entries().next().value as
        [string, string] | undefined;
      if (!entry) {
        await sleep(25);
        continue;
      }
      const [mint, signature] = entry;
      pendingFallback.delete(mint);
      const state = mints.get(mint);
      if (!state) continue;
      try {
        const tx = await pacer.run(() =>
          connection.getParsedTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 1,
          } as any),
        );
        if (!tx) continue;
        const parsed = genericPrice(
          tx as ParsedTransactionWithMeta,
          mint,
          state.decimals,
        );
        if (!parsed) continue;
        await emitPrice({
          type: "price",
          atMs: parsed.atMs,
          signature,
          slot: (tx as ParsedTransactionWithMeta).slot,
          mint,
          venue: "rpc-fallback",
          priceSol: parsed.priceSol,
          priceUsd: parsed.priceUsd,
          source: "explicit-mint-fallback",
        });
      } catch (error) {
        rpcErrors += 1;
        report("fallback enrichment error", {
          mint,
          signature,
          error: errorText(error),
        });
      }
    }
  };

  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await refreshSolUsd();
  report("ready", {
    url: `ws://${host}:${port}/ws`,
    health: `http://${host}:${port}/health`,
    upstreamProgramSubscriptions: programSubs.length,
    maxFallbackSubscriptions,
    rpcReadRps: readRps,
    rpcHardRps: hardRps,
    includeMayhem,
  });

  const heartbeat = setInterval(
    () => {
      report("heartbeat", {
        clients: clients.size,
        clientConnections,
        upstreamProgramSubscriptions: programSubs.length,
        fallbackSubscriptions: fallbackSubs.size,
        knownMints: mints.size,
        cachedLaunches: launchesByMint.size,
        pools: pools.size,
        latestPrices: latest.size,
        launches,
        prices,
        pendingFallbackMints: pendingFallback.size,
        coalescedFallbackUpdates: coalescedFallback,
        rpcQueue: pacer.queued,
        rpcErrors,
        solUsd,
        solUsdAgeMs: solUsdAt ? Date.now() - solUsdAt : null,
      });
    },
    Math.max(1_000, Math.trunc(numberFlag(args.flags, "heartbeat-ms", 15_000))),
  );
  const solTimer = setInterval(() => void refreshSolUsd(), 30_000);
  const pruneTimer = setInterval(() => {
    const cutoff = Date.now() - 6 * 60 * 60_000;
    if (mints.size > 50_000) {
      for (const [mint, state] of mints) {
        if (state.lastSeenAtMs < cutoff && !fallbackSubs.has(mint)) {
          mints.delete(mint);
          latest.delete(mint);
          launchesByMint.delete(mint);
        }
      }
    }
  }, 60_000);

  try {
    await fallbackLoop();
  } finally {
    clearInterval(heartbeat);
    clearInterval(solTimer);
    clearInterval(pruneTimer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    for (const id of programSubs)
      await connection.removeOnLogsListener(id).catch(() => undefined);
    for (const row of fallbackSubs.values())
      await connection.removeOnLogsListener(row.id).catch(() => undefined);
    server.stop(true);
    report("stopped", { clients: clients.size, launches, prices, rpcErrors });
  }
}
