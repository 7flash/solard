import bs58 from "bs58";
import {
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  WRAPPED_SOL_MINT as WRAPPED_SOL_PUBLIC_KEY,
} from "../venues/pump/constants.ts";
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

export type LaunchVenue = "pump" | "raydium-launchlab";
export type MigrationVenue = "pump" | "raydium-launchlab";
export type MigrationDestination = "pumpswap" | "raydium-amm" | "raydium-cpmm";
export type TradeVenue = "pump" | "pumpswap" | "raydium-launchlab";
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
    };

export type RaydiumLaunchLabDecodedEvent =
  | { kind: "pool"; pool: string }
  | {
      kind: "trade";
      pool: string;
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

export type TradeEvent = {
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
  virtualBaseRaw: bigint | null;
  virtualQuoteRaw: bigint | null;
  priceQuote: number | null;
  metadata: TokenMetadata | null;
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
    const quoteRaw = c.u64();
    const baseRaw = c.u64();
    const side: TradeSide = c.bool() ? "buy" : "sell";
    c.pubkey();
    const atMs = timestamp(c.i64());
    const virtualQuoteRaw = c.u64();
    const virtualBaseRaw = c.u64();
    return {
      kind: "trade",
      atMs,
      mint,
      side,
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
    c.u64();
    c.u64();
    c.u64();
    c.u64();
    const baseRaw = c.u64();
    const quoteRaw = c.u64();
    for (let index = 0; index < 7; index += 1) c.u64();
    const pool = c.pubkey();
    return { kind: "trade", atMs, pool, side, baseRaw, quoteRaw };
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
    return { kind: "trade", pool, virtualBaseRaw, virtualQuoteRaw };
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
  quoteMint: string | null;
  quoteDecimals: number | null;
  pool: string | null;
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
  const preferred =
    rows.find((row) => row.mint === WRAPPED_SOL_MINT) ??
    rows.find((row) => row.mint === USDC_MINT) ??
    rows[0];
  return preferred
    ? { mint: preferred.mint, decimals: preferred.decimals }
    : null;
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
  event: LaunchEvent | MigrationEvent | TradeEvent,
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
      const quote = quoteFromTransaction(parsed, mint);
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
        quoteMint: quote?.mint ?? WRAPPED_SOL_MINT,
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

export async function subscribeTrades(options: {
  connection: Connection;
  tokens: readonly string[];
  venues?: readonly TradeVenue[];
  commitment?: Commitment;
  metadata?: TokenMetadataMode;
  signal?: AbortSignal;
  onTrade: (event: TradeEvent) => void | Promise<void>;
  onStatus?: (event: string, data?: Record<string, unknown>) => void;
}): Promise<TradeSubscription> {
  const venues = new Set<TradeVenue>(
    options.venues ?? ["pump", "pumpswap", "raydium-launchlab"],
  );
  const commitment = options.commitment ?? "processed";
  const metadataMode = options.metadata ?? false;
  const subscriptions = new Map<string, number>();
  const states = new Map<string, TradeTokenState>();
  const metadataFetches = new Map<string, Promise<void>>();
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

  const deliver = async (value: Omit<TradeEvent, "metadata">) => {
    const event: TradeEvent = {
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

  const ensureMetadata = async (mint: string, signature?: string) => {
    const existing = metadataFetches.get(mint);
    if (existing) return await existing;
    const state = states.get(mint);
    if (!state) return;
    if (state.decimals != null && (state.quoteMint != null || !signature))
      return;
    const pending = (async () => {
      try {
        if (state.decimals == null) {
          const supply = await options.connection.getTokenSupply(
            new PublicKey(mint),
            "confirmed",
          );
          state.decimals = supply.value.decimals;
        }
        if (signature && state.quoteMint == null) {
          const tx = await options.connection.getParsedTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 1,
          });
          if (tx) {
            const quote = quoteFromTransaction(
              tx as ParsedTransactionWithMeta,
              mint,
            );
            if (quote) {
              state.quoteMint = quote.mint;
              state.quoteDecimals = quote.decimals;
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
    await ensureMetadata(mint, signature);
    const state = states.get(mint);
    if (!state || stopped || !subscriptions.has(mint)) return;
    if (state.quoteMint == null) {
      state.quoteMint = WRAPPED_SOL_MINT;
      state.quoteDecimals = 9;
    }
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
      virtualBaseRaw: decoded.virtualBaseRaw,
      virtualQuoteRaw: decoded.virtualQuoteRaw,
      priceQuote:
        qDecimals == null
          ? null
          : priceQuote(
              decoded.virtualBaseRaw,
              decoded.virtualQuoteRaw,
              baseDecimals,
              qDecimals,
            ),
    });
  };

  const emitPumpSwapTrade = async (
    mint: string,
    signature: string,
    slot: number,
    decoded: Extract<PumpSwapDecodedEvent, { kind: "trade" }>,
  ) => {
    await ensureMetadata(mint, signature);
    const state = states.get(mint);
    if (!state || stopped || !subscriptions.has(mint)) return;
    state.pool = decoded.pool;
    await deliver({
      type: "trade",
      venue: "pumpswap",
      signature,
      slot,
      atMs: decoded.atMs,
      mint,
      pool: decoded.pool,
      side: decoded.side,
      quoteMint: state.quoteMint,
      baseDecimals: state.decimals,
      quoteDecimals: state.quoteDecimals,
      baseRaw: decoded.baseRaw,
      quoteRaw: decoded.quoteRaw,
      virtualBaseRaw: null,
      virtualQuoteRaw: null,
      priceQuote:
        state.decimals == null || state.quoteDecimals == null
          ? null
          : priceQuote(
              decoded.baseRaw,
              decoded.quoteRaw,
              state.decimals,
              state.quoteDecimals,
            ),
    });
  };

  const emitLaunchLabTrade = async (
    mint: string,
    signature: string,
    slot: number,
    decoded: Extract<RaydiumLaunchLabDecodedEvent, { kind: "trade" }>,
  ) => {
    await ensureMetadata(mint, signature);
    const state = states.get(mint);
    if (!state || stopped || !subscriptions.has(mint)) return;
    state.pool = decoded.pool;
    await deliver({
      type: "trade",
      venue: "raydium-launchlab",
      signature,
      slot,
      atMs: Date.now(),
      mint,
      pool: decoded.pool,
      side: null,
      quoteMint: state.quoteMint,
      baseDecimals: state.decimals,
      quoteDecimals: state.quoteDecimals,
      baseRaw: null,
      quoteRaw: null,
      virtualBaseRaw: decoded.virtualBaseRaw,
      virtualQuoteRaw: decoded.virtualQuoteRaw,
      priceQuote:
        state.decimals == null || state.quoteDecimals == null
          ? null
          : priceQuote(
              decoded.virtualBaseRaw,
              decoded.virtualQuoteRaw,
              state.decimals,
              state.quoteDecimals,
            ),
    });
  };

  const onTokenLogs = (
    mint: string,
    logs: { err: unknown; logs: string[]; signature: string },
    slot: number,
  ) => {
    if (logs.err || stopped || !subscriptions.has(mint)) return;
    for (const entry of programDataEntries(logs.logs)) {
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
          const state = states.get(mint);
          if (state) {
            state.decimals = decoded.baseDecimals;
            state.quoteMint = decoded.quoteMint;
            state.quoteDecimals = decoded.quoteDecimals;
            state.pool = decoded.pool;
          }
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
