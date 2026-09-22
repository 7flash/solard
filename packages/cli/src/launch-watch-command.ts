import { configure, createMeasure } from "measure-fn";
import bs58 from "bs58";
import {
  Connection,
  PublicKey,
  type Logs,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";

type Flags = Map<string, string>;
type Emit = (value: string) => void;

type VenueId = "pump" | "raydium-launchlab";

type TokenState = {
  mint: string;
  venue: VenueId;
  createdAtMs: number;
  lastSeenAtMs: number;
  decimals: number;
  supplyUi: number;
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  subscriptionId: number | null;
  isMayhemMode: boolean | null;
  qualified: boolean;
  athMarketCapUsd: number | null;
  lastNotifiedAthUsd: number | null;
};

type Trade = {
  atMs: number;
  side: "buy" | "sell";
  trader: string;
  tokenAmountUi: number;
  quote: "SOL" | "USDC";
  quoteAmountUi: number;
  priceSol: number | null;
  priceUsd: number | null;
};

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_LAUNCHPAD_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LAMPORTS_PER_SOL = 1_000_000_000;
const MAX_SUPPORTED_TRANSACTION_VERSION = 1;
const PUMP_CREATE_D8 = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);
const PUMP_CREATE_V2_D8 = Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]);

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

function integerFlag(flags: Flags, key: string, fallback: number): number {
  const value = numberFlag(flags, key, fallback);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`--${key} must be a positive integer`);
  return value;
}

function duration(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const scale = ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const)[
    (match[2]?.toLowerCase() ?? "ms") as "ms" | "s" | "m" | "h"
  ];
  return Math.max(100, Math.floor(Number(match[1]) * scale));
}

function rpcUrl(flags: Flags): string {
  const value =
    flag(flags, "rpc") ??
    process.env.RPC_ENDPOINT?.trim() ??
    process.env.SOLANA_RPC_URL?.trim() ??
    process.env.HELIUS_RPC_URL?.trim();
  if (!value)
    throw new Error(
      "launch watch requires RPC_ENDPOINT, SOLANA_RPC_URL, HELIUS_RPC_URL, or --rpc <url>",
    );
  return value;
}

function venues(flags: Flags): VenueId[] {
  const raw = flag(flags, "venue") ?? "pump,raydium-launchlab";
  const values = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) =>
      value === "launchlab" || value === "raydium" || value === "stonkfun"
        ? "raydium-launchlab"
        : value,
    );
  const out = [...new Set(values)] as string[];
  for (const value of out) {
    if (value !== "pump" && value !== "raydium-launchlab")
      throw new Error(`Unsupported --venue value: ${value}`);
  }
  return out as VenueId[];
}

function usd(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: value < 10_000 ? 2 : 0,
    maximumFractionDigits: value < 10_000 ? 2 : 0,
  });
}

function finitePositive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function fetchJson(url: string): Promise<unknown> {
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

async function fetchSolUsd(): Promise<number> {
  try {
    const raw = (await fetchJson(
      "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    )) as { data?: { amount?: unknown } };
    const value = finitePositive(raw?.data?.amount);
    if (value != null) return value;
  } catch {}
  const raw = (await fetchJson(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  )) as { solana?: { usd?: unknown } };
  const value = finitePositive(raw?.solana?.usd);
  if (value == null) throw new Error("SOL/USD price unavailable");
  return value;
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

function accountKeys(tx: ParsedTransactionWithMeta): string[] {
  return ((tx.transaction.message as any).accountKeys ?? [])
    .map((row: unknown) => keyText(row))
    .filter((row: string | null): row is string => Boolean(row));
}

function signerKeys(tx: ParsedTransactionWithMeta): Set<string> {
  const rows = ((tx.transaction.message as any).accountKeys ?? []) as any[];
  const explicit = rows
    .filter((row) => row && typeof row === "object" && row.signer === true)
    .map((row) => keyText(row))
    .filter((row): row is string => Boolean(row));
  return new Set(explicit);
}

function rawAmount(row: any): bigint {
  try {
    return BigInt(String(row?.uiTokenAmount?.amount ?? "0"));
  } catch {
    return 0n;
  }
}

function tokenBalances(rows: readonly any[] | null | undefined) {
  return (rows ?? []).map((row) => ({
    accountIndex: Number(row.accountIndex),
    mint: String(row.mint ?? ""),
    owner: row.owner ? String(row.owner) : null,
    raw: rawAmount(row),
  }));
}

function ownerTokenDeltaRaw(
  tx: ParsedTransactionWithMeta,
  mint: string,
  owner: string,
): bigint {
  const pre = tokenBalances(tx.meta?.preTokenBalances);
  const post = tokenBalances(tx.meta?.postTokenBalances);
  const indices = new Set<number>();
  for (const row of [...pre, ...post])
    if (row.mint === mint && row.owner === owner) indices.add(row.accountIndex);
  let total = 0n;
  for (const index of indices) {
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

function economicSolDelta(
  tx: ParsedTransactionWithMeta,
  owner: string,
): bigint | null {
  if (!tx.meta) return null;
  const keys = accountKeys(tx);
  const index = keys.indexOf(owner);
  if (index < 0) return null;
  const before = tx.meta.preBalances[index];
  const after = tx.meta.postBalances[index];
  if (before == null || after == null) return null;
  const native =
    BigInt(Math.trunc(Number(after))) - BigInt(Math.trunc(Number(before)));
  const fee = keys[0] === owner ? BigInt(tx.meta.fee ?? 0) : 0n;
  const rent = tokenAccountRentDelta(tx, owner);
  const wsol = ownerTokenDeltaRaw(tx, WSOL_MINT, owner);
  return native + fee + rent + wsol;
}

function parseTrade(
  tx: ParsedTransactionWithMeta,
  token: TokenState,
): Trade | null {
  if (!tx.meta || tx.meta.err) return null;
  const tradedAtMs = tx.blockTime == null ? Date.now() : tx.blockTime * 1_000;
  const signers = signerKeys(tx);
  const owners = new Set<string>();
  for (const row of [
    ...tokenBalances(tx.meta.preTokenBalances),
    ...tokenBalances(tx.meta.postTokenBalances),
  ]) {
    if (row.mint === token.mint && row.owner && signers.has(row.owner))
      owners.add(row.owner);
  }
  for (const owner of owners) {
    const targetDelta = ownerTokenDeltaRaw(tx, token.mint, owner);
    if (targetDelta === 0n) continue;
    const side = targetDelta > 0n ? "buy" : "sell";
    const tokenUi =
      Number(targetDelta < 0n ? -targetDelta : targetDelta) /
      10 ** token.decimals;
    if (!(tokenUi > 0) || !Number.isFinite(tokenUi)) continue;

    const solDelta = economicSolDelta(tx, owner);
    if (
      solDelta != null &&
      ((side === "buy" && solDelta < 0n) || (side === "sell" && solDelta > 0n))
    ) {
      const solUi =
        Number(solDelta < 0n ? -solDelta : solDelta) / LAMPORTS_PER_SOL;
      if (solUi > 0 && Number.isFinite(solUi)) {
        return {
          atMs: tradedAtMs,
          side,
          trader: owner,
          tokenAmountUi: tokenUi,
          quote: "SOL",
          quoteAmountUi: solUi,
          priceSol: solUi / tokenUi,
          priceUsd: null,
        };
      }
    }

    const usdcDelta = ownerTokenDeltaRaw(tx, USDC_MINT, owner);
    if (
      (side === "buy" && usdcDelta < 0n) ||
      (side === "sell" && usdcDelta > 0n)
    ) {
      const usdcUi =
        Number(usdcDelta < 0n ? -usdcDelta : usdcDelta) / 1_000_000;
      if (usdcUi > 0 && Number.isFinite(usdcUi)) {
        return {
          atMs: tradedAtMs,
          side,
          trader: owner,
          tokenAmountUi: tokenUi,
          quote: "USDC",
          quoteAmountUi: usdcUi,
          priceSol: null,
          priceUsd: usdcUi / tokenUi,
        };
      }
    }
  }
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
  if (!out.size) {
    const pre = new Set(
      tokenBalances(tx.meta?.preTokenBalances).map((row) => row.mint),
    );
    const post = tokenBalances(tx.meta?.postTokenBalances)
      .map((row) => row.mint)
      .filter(
        (mint) =>
          mint && mint !== WSOL_MINT && mint !== USDC_MINT && !pre.has(mint),
      );
    const pump = post.find((mint) => /pump$/i.test(mint));
    if (pump) out.add(pump);
    else if (post.length === 1) out.add(post[0]!);
  }
  return [...out];
}

function readPumpString(
  buffer: Buffer,
  offset: number,
): { value: string; offset: number } | null {
  if (offset + 4 > buffer.length) return null;
  const length = buffer.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  if (length > 2048 || end > buffer.length) return null;
  return { value: buffer.subarray(start, end).toString("utf8"), offset: end };
}

function pumpCreateMeta(
  tx: ParsedTransactionWithMeta,
  mint: string,
): {
  name: string | null;
  symbol: string | null;
  isMayhemMode: boolean | null;
} | null {
  for (const ix of instructions(tx)) {
    if (keyText((ix as any)?.programId) !== PUMP_PROGRAM) continue;
    const accounts = Array.isArray((ix as any)?.accounts)
      ? (ix as any).accounts.map((value: unknown) => keyText(value))
      : [];
    if (accounts[0] && accounts[0] !== mint) continue;
    const encoded = (ix as any)?.data;
    if (typeof encoded !== "string") continue;
    let buffer: Buffer;
    try {
      buffer = Buffer.from(bs58.decode(encoded));
    } catch {
      continue;
    }
    if (buffer.length < 8) continue;
    const discriminator = buffer.subarray(0, 8);
    const v2 = discriminator.equals(PUMP_CREATE_V2_D8);
    const legacy = discriminator.equals(PUMP_CREATE_D8);
    if (!v2 && !legacy) continue;
    let offset = 8;
    const name = readPumpString(buffer, offset);
    if (!name) return null;
    offset = name.offset;
    const symbol = readPumpString(buffer, offset);
    if (!symbol) return null;
    offset = symbol.offset;
    const uri = readPumpString(buffer, offset);
    if (!uri) return null;
    offset = uri.offset;
    if (offset + 32 <= buffer.length) offset += 32;
    const isMayhemMode = v2
      ? offset < buffer.length
        ? buffer[offset] === 1
        : null
      : false;
    return {
      name: name.value || null,
      symbol: symbol.value || null,
      isMayhemMode,
    };
  }
  return null;
}

function createLike(logs: readonly string[], venue: VenueId): boolean {
  const text = logs.join("\n");
  if (venue === "pump") return /Instruction:\s*Create(?:V2)?\b/i.test(text);
  return /Instruction:\s*(?:InitializeMint2?|Initialize|InitializeV2|Create|CreateLaunchpad|InitializeLaunchpad)\b/i.test(
    text,
  );
}

function rpcReadRate(flags: Flags): { hard: number; read: number } {
  const raw = flag(flags, "rpc-rps") ?? process.env.SLRD_RPC_MAX_RPS ?? "5";
  const hardValue = Number(raw);
  if (!Number.isFinite(hardValue) || hardValue <= 0)
    throw new Error(`Invalid RPC rate: ${raw}`);
  const hard = Math.max(1, Math.floor(hardValue));
  const defaultRead = hard > 1 ? Math.min(2, hard - 1) : 1;
  const readRaw = flag(flags, "rpc-read-rps");
  const readValue = readRaw == null ? defaultRead : Number(readRaw);
  if (!Number.isFinite(readValue) || readValue <= 0)
    throw new Error(`Invalid --rpc-read-rps: ${readRaw}`);
  return {
    hard,
    read: Math.max(1, Math.min(hard, Math.floor(readValue))),
  };
}

class RpcPacer {
  private tail: Promise<unknown> = Promise.resolve();
  private nextAt = 0;
  private pending = 0;

  constructor(readonly rps: number) {}

  get queued(): number {
    return this.pending;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const step = Math.ceil(1_000 / this.rps);
    const execute = async () => {
      const wait = Math.max(0, this.nextAt - Date.now());
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.nextAt = Math.max(this.nextAt, Date.now()) + step;
      try {
        return await fn();
      } finally {
        this.pending -= 1;
      }
    };
    const result = this.tail.then(execute, execute);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function heliusTransactionWsUrl(flags: Flags, httpUrl: string): string | null {
  const explicit =
    flag(flags, "ws") ??
    process.env.HELIUS_WS_URL?.trim() ??
    process.env.SOLARD_WS_URL?.trim();
  if (explicit) return explicit;
  let url: URL;
  try {
    const httpCandidate = new URL(httpUrl);
    const heliusCandidate = process.env.HELIUS_RPC_URL?.trim();
    url = /helius-rpc\.com$/i.test(httpCandidate.hostname)
      ? httpCandidate
      : heliusCandidate
        ? new URL(heliusCandidate)
        : httpCandidate;
  } catch {
    return null;
  }
  if (!/helius-rpc\.com$/i.test(url.hostname)) return null;
  url.protocol = "wss:";
  if (url.hostname === "mainnet.helius-rpc.com")
    url.hostname = "atlas-mainnet.helius-rpc.com";
  if (url.hostname === "devnet.helius-rpc.com")
    url.hostname = "atlas-devnet.helius-rpc.com";
  return url.toString();
}

function wsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer)
    return new TextDecoder().decode(new Uint8Array(value));
  if (ArrayBuffer.isView(value))
    return new TextDecoder().decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  return String(value ?? "");
}

function enhancedParsedTransaction(
  result: any,
): { signature: string; tx: ParsedTransactionWithMeta } | null {
  const envelope = result?.transaction;
  const transaction = envelope?.transaction;
  const meta = envelope?.meta;
  if (!transaction || !meta) return null;
  const signature =
    typeof result?.signature === "string"
      ? result.signature
      : typeof transaction?.signatures?.[0] === "string"
        ? transaction.signatures[0]
        : null;
  if (!signature) return null;
  return {
    signature,
    tx: {
      slot: Number(result?.slot ?? envelope?.slot ?? 0),
      blockTime:
        typeof result?.blockTime === "number"
          ? result.blockTime
          : typeof envelope?.blockTime === "number"
            ? envelope.blockTime
            : null,
      meta,
      transaction,
      version: envelope?.version ?? 0,
    } as ParsedTransactionWithMeta,
  };
}

function transactionVenue(tx: ParsedTransactionWithMeta): VenueId | null {
  const keys = new Set(accountKeys(tx));
  if (keys.has(PUMP_PROGRAM)) return "pump";
  if (keys.has(RAYDIUM_LAUNCHPAD_PROGRAM)) return "raydium-launchlab";
  return null;
}

function transactionMints(tx: ParsedTransactionWithMeta): Set<string> {
  return new Set(
    [
      ...tokenBalances(tx.meta?.preTokenBalances),
      ...tokenBalances(tx.meta?.postTokenBalances),
    ]
      .map((row) => row.mint)
      .filter(Boolean),
  );
}

function supplyFromTransaction(
  tx: ParsedTransactionWithMeta,
  mint: string,
): { decimals: number; supplyUi: number } | null {
  const rows = (tx.meta?.postTokenBalances ?? []).filter(
    (row: any) => String(row?.mint ?? "") === mint,
  );
  if (!rows.length) return null;
  const decimals = Number(rows[0]?.uiTokenAmount?.decimals);
  if (!Number.isInteger(decimals) || decimals < 0) return null;
  const amounts = new Map<number, bigint>();
  for (const row of rows) {
    const index = Number(row?.accountIndex);
    if (Number.isInteger(index)) amounts.set(index, rawAmount(row));
  }
  const raw = [...amounts.values()].reduce((sum, value) => sum + value, 0n);
  const supplyUi = Number(raw) / 10 ** decimals;
  return Number.isFinite(supplyUi) && supplyUi > 0
    ? { decimals, supplyUi }
    : null;
}

type TransactionStream = {
  close(): void;
  closed: Promise<void>;
};

async function openHeliusTransactionStream(args: {
  url: string;
  accounts: string[];
  onTransaction: (result: any) => void;
}): Promise<TransactionStream> {
  return await new Promise<TransactionStream>((resolve, reject) => {
    const ws = new WebSocket(args.url);
    const requestId = 74121;
    let ready = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((done) => {
      resolveClosed = done;
    });
    const timeout = setTimeout(() => {
      if (!ready) {
        try {
          ws.close();
        } catch {}
        reject(new Error("transactionSubscribe handshake timed out"));
      }
    }, 5_000);

    const rejectBeforeReady = (message: string) => {
      if (ready) return;
      clearTimeout(timeout);
      reject(new Error(message));
    };

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method: "transactionSubscribe",
          params: [
            { failed: false, accountInclude: args.accounts },
            {
              commitment: "confirmed",
              encoding: "jsonParsed",
              transactionDetails: "full",
              maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION,
            },
          ],
        }),
      );
    });

    ws.addEventListener("message", (event) => {
      let message: any;
      try {
        message = JSON.parse(wsText(event.data));
      } catch {
        return;
      }
      if (message?.id === requestId) {
        if (message?.error) {
          rejectBeforeReady(
            `transactionSubscribe unavailable: ${message.error.message ?? JSON.stringify(message.error)}`,
          );
          return;
        }
        if (!ready) {
          ready = true;
          clearTimeout(timeout);
          resolve({
            close: () => {
              try {
                ws.close();
              } catch {}
            },
            closed,
          });
        }
        return;
      }
      if (message?.params?.result?.transaction)
        args.onTransaction(message.params.result);
    });

    ws.addEventListener("error", () => {
      rejectBeforeReady("transactionSubscribe websocket error");
    });

    ws.addEventListener("close", () => {
      clearTimeout(timeout);
      rejectBeforeReady("transactionSubscribe websocket closed");
      resolveClosed();
    });
  });
}

export async function runLaunchWatchCommand(args: {
  flags: Flags;
  emit: Emit;
  forcedVenues?: VenueId[];
}): Promise<void> {
  configure({
    silent: false,
    logger(_event: unknown, next?: () => void) {
      next?.();
    },
  });
  const m = createMeasure("slrd:launch-watch", { maxResultLength: 1600 });
  const note = <T>(label: string, value: T): T =>
    m.sync(
      {
        start: () => label,
        end: (result: T) => result,
      },
      () => value,
    );

  const selectedVenues = args.forcedVenues ?? venues(args.flags);
  const trackTtlMs = duration(flag(args.flags, "track-ttl"), 30 * 60_000);
  const maxTracked = integerFlag(args.flags, "max-tracked", 500);
  const showTrades = args.flags.has("trades");
  const showNew = args.flags.has("show-new");
  const includeMayhem = args.flags.has("include-mayhem");
  const minMarketCapUsd = numberFlag(args.flags, "min-mcap", 5_000);
  const athStepPct = numberFlag(args.flags, "ath-step-pct", 20);
  if (!(minMarketCapUsd > 0)) throw new Error("--min-mcap must be > 0");
  if (!(athStepPct > 0)) throw new Error("--ath-step-pct must be > 0");
  const followTrades = true;
  const json = args.flags.has("json");
  const httpRpcUrl = rpcUrl(args.flags);
  const connection = new Connection(httpRpcUrl, "confirmed");
  const rate = rpcReadRate(args.flags);
  const pacer = new RpcPacer(rate.read);
  const tokens = new Map<string, TokenState>();
  const processedSignatures = new Map<string, number>();
  const programSubscriptions: number[] = [];
  let stopped = false;
  let streamMode: "helius-transaction" | "standard-logs" = "standard-logs";
  let transactionStream: TransactionStream | null = null;
  let streamReconnects = 0;
  let streamFilterRevision = 0;
  let activeStreamFilterRevision = -1;
  let streamRefreshing = false;
  let solUsdValue: number | null = null;
  let solUsdUpdatedAtMs = 0;
  let creates = 0;
  let createsFilteredMayhem = 0;
  let createDecodeSkipped = 0;
  let thresholdNotifications = 0;
  let athNotifications = 0;
  let trades = 0;
  let fetchErrors = 0;
  let eventQueue = 0;
  let eventTail: Promise<void> = Promise.resolve();

  const output = <T extends Record<string, unknown>>(
    label: string,
    value: T,
  ) => {
    if (json) args.emit(`${JSON.stringify({ type: label, ...value })}\n`);
    else note(label, value);
  };

  const enqueueEvent = (operation: () => Promise<void>) => {
    eventQueue += 1;
    const run = async () => {
      try {
        await operation();
      } catch (error) {
        fetchErrors += 1;
        output("event error", {
          error: error instanceof Error ? error.message : String(error),
          queued: eventQueue,
        });
      } finally {
        eventQueue -= 1;
      }
    };
    eventTail = eventTail.then(run, run);
  };

  const solUsd = async (): Promise<number | null> => {
    if (solUsdValue != null && Date.now() - solUsdUpdatedAtMs < 30_000)
      return solUsdValue;
    try {
      solUsdValue = await fetchSolUsd();
      solUsdUpdatedAtMs = Date.now();
    } catch (error) {
      output("sol/usd unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return solUsdValue;
  };

  const removeToken = async (token: TokenState) => {
    tokens.delete(token.mint);
    if (followTrades) streamFilterRevision += 1;
    if (token.subscriptionId != null) {
      try {
        await connection.removeOnLogsListener(token.subscriptionId);
      } catch {}
      token.subscriptionId = null;
    }
  };

  const prune = async () => {
    const now = Date.now();
    const rows = [...tokens.values()].sort(
      (left, right) => left.lastSeenAtMs - right.lastSeenAtMs,
    );
    for (const token of rows) {
      if (token.qualified) continue;
      if (now - token.lastSeenAtMs > trackTtlMs || tokens.size > maxTracked)
        await removeToken(token);
    }
  };

  const processParsedTokenTransaction = async (
    token: TokenState,
    signature: string,
    tx: ParsedTransactionWithMeta,
  ) => {
    const identity = `${token.mint}:${signature}`;
    if (processedSignatures.has(identity)) return;
    processedSignatures.set(identity, Date.now());
    const trade = parseTrade(tx, token);
    if (!trade) return;
    trades += 1;
    token.lastSeenAtMs = trade.atMs;
    if (trade.priceSol != null) {
      token.priceSol = trade.priceSol;
      const s = await solUsd();
      if (s != null) token.priceUsd = trade.priceSol * s;
    } else if (trade.priceUsd != null) {
      token.priceUsd = trade.priceUsd;
    }
    if (token.priceUsd != null && token.supplyUi > 0)
      token.marketCapUsd = token.priceUsd * token.supplyUi;

    const marketCapUsd = token.marketCapUsd;
    if (marketCapUsd != null && Number.isFinite(marketCapUsd)) {
      if (!token.qualified && marketCapUsd >= minMarketCapUsd) {
        token.qualified = true;
        token.athMarketCapUsd = marketCapUsd;
        token.lastNotifiedAthUsd = marketCapUsd;
        thresholdNotifications += 1;
        if (!json && !args.flags.has("no-bell")) process.stdout.write("\x07");
        output("market cap threshold", {
          at: new Date(trade.atMs).toISOString(),
          venue: token.venue,
          mint: token.mint,
          marketCapUsd,
          thresholdMarketCapUsd: minMarketCapUsd,
          priceUsd: token.priceUsd,
          priceSol: token.priceSol,
          signature,
        });
      } else if (token.qualified) {
        const previousAth = token.athMarketCapUsd ?? marketCapUsd;
        if (marketCapUsd > previousAth) {
          token.athMarketCapUsd = marketCapUsd;
          const lastNotified = token.lastNotifiedAthUsd ?? previousAth;
          const notifyAt = lastNotified * (1 + athStepPct / 100);
          if (marketCapUsd >= notifyAt) {
            token.lastNotifiedAthUsd = marketCapUsd;
            athNotifications += 1;
            if (!json && !args.flags.has("no-bell"))
              process.stdout.write("\x07");
            output("new ath", {
              at: new Date(trade.atMs).toISOString(),
              venue: token.venue,
              mint: token.mint,
              marketCapUsd,
              previousNotifiedAthUsd: lastNotified,
              athStepPct,
              increasePct: (marketCapUsd / lastNotified - 1) * 100,
              priceUsd: token.priceUsd,
              priceSol: token.priceSol,
              signature,
            });
          }
        }
      }
    }

    if (showTrades) {
      output("trade", {
        at: new Date(trade.atMs).toISOString(),
        venue: token.venue,
        mint: token.mint,
        signature,
        side: trade.side,
        trader: trade.trader,
        tokenAmountUi: trade.tokenAmountUi,
        quote: trade.quote,
        quoteAmountUi: trade.quoteAmountUi,
        priceSol: token.priceSol,
        priceUsd: token.priceUsd,
        marketCapUsd: token.marketCapUsd,
      });
    }
  };

  const fetchParsedTransaction = async (
    signature: string,
  ): Promise<ParsedTransactionWithMeta | null> => {
    let tx: ParsedTransactionWithMeta | null = null;
    for (let attempt = 0; attempt < 5 && !tx && !stopped; attempt += 1) {
      try {
        tx = await pacer.run(() =>
          connection.getParsedTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION,
          }),
        );
      } catch (error) {
        fetchErrors += 1;
        if (attempt === 4) {
          output("rpc enrichment error", {
            signature,
            attempts: attempt + 1,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!tx)
        await new Promise((resolve) =>
          setTimeout(resolve, 250 + attempt * 200),
        );
    }
    return tx;
  };

  const processTokenTransaction = async (
    token: TokenState,
    signature: string,
  ) => {
    const tx = await fetchParsedTransaction(signature);
    if (tx) await processParsedTokenTransaction(token, signature, tx);
  };

  const subscribeMint = (token: TokenState) => {
    if (
      !followTrades ||
      streamMode !== "standard-logs" ||
      token.subscriptionId != null
    )
      return;
    token.subscriptionId = connection.onLogs(
      new PublicKey(token.mint),
      (log: Logs) => {
        if (!log.err)
          enqueueEvent(() => processTokenTransaction(token, log.signature));
      },
      "processed",
    );
  };

  const registerCreateFromTransaction = async (
    venue: VenueId,
    signature: string,
    tx: ParsedTransactionWithMeta,
  ) => {
    if (tx.meta?.err) return;
    for (const mint of initializedMints(tx)) {
      if (tokens.has(mint)) continue;
      let supply = supplyFromTransaction(tx, mint);
      if (!supply) {
        try {
          const value = await pacer.run(() =>
            connection.getTokenSupply(new PublicKey(mint), "confirmed"),
          );
          const supplyUi = Number(value.value.uiAmountString ?? "0");
          if (Number.isFinite(supplyUi) && supplyUi > 0) {
            supply = { decimals: value.value.decimals, supplyUi };
          }
        } catch (error) {
          fetchErrors += 1;
          output("token supply error", {
            mint,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!supply) continue;
      const createMeta = venue === "pump" ? pumpCreateMeta(tx, mint) : null;
      if (
        venue === "pump" &&
        !includeMayhem &&
        (createMeta?.isMayhemMode === true || createMeta == null)
      ) {
        if (createMeta?.isMayhemMode === true) createsFilteredMayhem += 1;
        else createDecodeSkipped += 1;
        continue;
      }
      const now = (tx.blockTime ?? Math.floor(Date.now() / 1_000)) * 1_000;
      const token: TokenState = {
        mint,
        venue,
        createdAtMs: now,
        lastSeenAtMs: now,
        decimals: supply.decimals,
        supplyUi: supply.supplyUi,
        priceSol: null,
        priceUsd: null,
        marketCapUsd: null,
        subscriptionId: null,
        isMayhemMode: createMeta?.isMayhemMode ?? null,
        qualified: false,
        athMarketCapUsd: null,
        lastNotifiedAthUsd: null,
      };
      tokens.set(mint, token);
      if (followTrades) streamFilterRevision += 1;
      creates += 1;
      subscribeMint(token);
      if (showNew) {
        output("new token", {
          at: new Date(now).toISOString(),
          venue,
          mint,
          name: createMeta?.name ?? null,
          symbol: createMeta?.symbol ?? null,
          decimals: supply.decimals,
          supplyUi: supply.supplyUi,
        });
      }
      if (followTrades)
        await processParsedTokenTransaction(token, signature, tx);
      await prune();
    }
  };

  const registerCreate = async (venue: VenueId, signature: string) => {
    const tx = await fetchParsedTransaction(signature);
    if (tx) await registerCreateFromTransaction(venue, signature, tx);
  };

  const programRows: Array<{ venue: VenueId; program: string }> = [];
  if (selectedVenues.includes("pump"))
    programRows.push({ venue: "pump", program: PUMP_PROGRAM });
  if (selectedVenues.includes("raydium-launchlab"))
    programRows.push({
      venue: "raydium-launchlab",
      program: RAYDIUM_LAUNCHPAD_PROGRAM,
    });

  const processEnhancedTransaction = (result: any) => {
    const parsed = enhancedParsedTransaction(result);
    if (!parsed) return;
    const venue = transactionVenue(parsed.tx);
    const touchedMints = transactionMints(parsed.tx);
    const touchesTracked =
      followTrades && [...touchedMints].some((mint) => tokens.has(mint));
    if ((!venue || !selectedVenues.includes(venue)) && !touchesTracked) return;
    enqueueEvent(async () => {
      const logs = parsed.tx.meta?.logMessages ?? [];
      if (venue && selectedVenues.includes(venue) && createLike(logs, venue)) {
        await registerCreateFromTransaction(venue, parsed.signature, parsed.tx);
      }
      if (followTrades) {
        for (const mint of touchedMints) {
          const token = tokens.get(mint);
          if (token)
            await processParsedTokenTransaction(
              token,
              parsed.signature,
              parsed.tx,
            );
        }
      }
    });
  };

  const startStandardSubscriptions = () => {
    streamMode = "standard-logs";
    for (const row of programRows) {
      const id = connection.onLogs(
        new PublicKey(row.program),
        (log: Logs) => {
          if (!log.err && createLike(log.logs, row.venue))
            enqueueEvent(() => registerCreate(row.venue, log.signature));
        },
        "processed",
      );
      programSubscriptions.push(id);
    }
    for (const token of tokens.values()) subscribeMint(token);
  };

  const enhancedUrl = heliusTransactionWsUrl(args.flags, httpRpcUrl);
  if (enhancedUrl && !args.flags.has("standard-ws")) {
    try {
      transactionStream = await openHeliusTransactionStream({
        url: enhancedUrl,
        accounts: [
          ...programRows.map((row) => row.program),
          ...(followTrades ? [...tokens.keys()] : []),
        ],
        onTransaction: processEnhancedTransaction,
      });
      streamMode = "helius-transaction";
      activeStreamFilterRevision = streamFilterRevision;
      output("transaction stream", { mode: streamMode, status: "connected" });
      const reconnect = async () => {
        while (!stopped && streamMode === "helius-transaction") {
          const current = transactionStream;
          if (!current) return;
          await current.closed;
          if (stopped || streamMode !== "helius-transaction") return;
          if (transactionStream !== current) continue;
          streamReconnects += 1;
          let replacement: TransactionStream | null = null;
          while (!replacement && !stopped) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            try {
              replacement = await openHeliusTransactionStream({
                url: enhancedUrl,
                accounts: [
                  ...programRows.map((row) => row.program),
                  ...(followTrades ? [...tokens.keys()] : []),
                ],
                onTransaction: processEnhancedTransaction,
              });
            } catch {}
          }
          transactionStream = replacement;
          activeStreamFilterRevision = streamFilterRevision;
        }
      };
      void reconnect();
    } catch (error) {
      output("transaction stream fallback", {
        mode: "standard-logs",
        reason: error instanceof Error ? error.message : String(error),
        rpcReadRps: rate.read,
        rpcHardRps: rate.hard,
      });
      startStandardSubscriptions();
    }
  } else {
    startStandardSubscriptions();
  }

  const refreshEnhancedFilter = async () => {
    if (
      stopped ||
      streamMode !== "helius-transaction" ||
      !enhancedUrl ||
      streamRefreshing ||
      activeStreamFilterRevision === streamFilterRevision
    )
      return;
    streamRefreshing = true;
    const revision = streamFilterRevision;
    try {
      const replacement = await openHeliusTransactionStream({
        url: enhancedUrl,
        accounts: [
          ...programRows.map((row) => row.program),
          ...(followTrades ? [...tokens.keys()] : []),
        ],
        onTransaction: processEnhancedTransaction,
      });
      const previous = transactionStream;
      transactionStream = replacement;
      activeStreamFilterRevision = revision;
      previous?.close();
    } catch (error) {
      output("transaction stream refresh error", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      streamRefreshing = false;
    }
  };

  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await solUsd();

  const streamRefreshTimer = setInterval(
    () => void refreshEnhancedFilter(),
    2_000,
  );
  const maintenanceTimer = setInterval(() => {
    void prune();
    const cutoff = Date.now() - 10 * 60_000;
    for (const [identity, at] of processedSignatures)
      if (at < cutoff) processedSignatures.delete(identity);
    void solUsd();
  }, 15_000);
  const heartbeatTimer = setInterval(() => {
    output("heartbeat", {
      stream: streamMode,
      venues: selectedVenues,
      newTokens: creates,
      filteredMayhem: createsFilteredMayhem,
      createDecodeSkipped,
      tracked: tokens.size,
      qualified: [...tokens.values()].filter((token) => token.qualified).length,
      trades,
      thresholdNotifications,
      athNotifications,
      rpcQueue: pacer.queued,
      eventQueue,
      rpcReadRps: rate.read,
      rpcHardRps: rate.hard,
      fetchErrors,
      reconnects: streamReconnects,
      solUsd: solUsdValue,
    });
  }, 15_000);

  output("ready", {
    stream: streamMode,
    venues: selectedVenues,
    minMarketCapUsd,
    athStepPct,
    excludeMayhem: !includeMayhem,
    trackTtlMs,
    maxTracked,
    rpcReadRps: rate.read,
    rpcHardRps: rate.hard,
    rawTrades: showTrades,
  });

  try {
    while (!stopped) await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    clearInterval(streamRefreshTimer);
    clearInterval(maintenanceTimer);
    clearInterval(heartbeatTimer);
    transactionStream?.close();
    for (const id of programSubscriptions) {
      try {
        await connection.removeOnLogsListener(id);
      } catch {}
    }
    for (const token of tokens.values()) {
      if (token.subscriptionId != null) {
        try {
          await connection.removeOnLogsListener(token.subscriptionId);
        } catch {}
      }
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    output("stopped", {
      stream: streamMode,
      newTokens: creates,
      filteredMayhem: createsFilteredMayhem,
      qualified: [...tokens.values()].filter((token) => token.qualified).length,
      trades,
      thresholdNotifications,
      athNotifications,
      fetchErrors,
      reconnects: streamReconnects,
    });
  }
}
