import { NATIVE_MINT } from "@solana/spl-token";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { Buffer } from "buffer";

import { parsePumpCreateData } from "../../pump/parsers/pump-create.ts";
import {
  AMM_BUY_D8,
  AMM_BUY_EVENT_D8,
  AMM_BUY_EXACT_QUOTE_IN_D8,
  AMM_SELL_D8,
  AMM_SELL_EVENT_D8,
  BUY_EXACT_QUOTE_IN_V2_D8,
  CREATE_V2_D8,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SELL_V2_D8,
} from "../../venues/pump/constants.ts";
import type {
  PumpSwapFeeBreakdown,
  TokenHistoryRaw,
  TokenHistorySide,
  TokenHistoryTrade,
  TokenHistoryVenue,
} from "./types.ts";

const HISTORY_PARSER_VERSION = "pump-history-v2-fees";
const LEGACY_CREATE_D8 = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);
const LAMPORTS_PER_SOL = 1_000_000_000;

type ClassifiedInstruction = {
  venue: TokenHistoryVenue;
  side: TokenHistorySide;
  kind: string;
  user: string;
  mint: string;
  pool: string | null;
  quoteMint: string | null;
  index: number;
  data: Buffer;
  protectedNativeDestinations: string[];
};

type TokenBalanceRow = {
  accountIndex: number;
  mint: string;
  owner: string | null;
  raw: bigint;
};

function keyText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const direct = value as { toBase58?: () => string; pubkey?: unknown };
  if (typeof direct.toBase58 === "function") return direct.toBase58();
  if (typeof direct.pubkey === "string") return direct.pubkey;
  if (
    direct.pubkey &&
    typeof direct.pubkey === "object" &&
    typeof (direct.pubkey as { toBase58?: () => string }).toBase58 ===
      "function"
  ) {
    return (direct.pubkey as { toBase58(): string }).toBase58();
  }
  return null;
}

function accountKeys(tx: ParsedTransactionWithMeta): string[] {
  const message = tx.transaction.message as unknown as {
    accountKeys?: unknown[];
    staticAccountKeys?: unknown[];
  };
  const staticKeys = Array.isArray(message.accountKeys)
    ? message.accountKeys
        .map(keyText)
        .filter((value): value is string => !!value)
    : Array.isArray(message.staticAccountKeys)
      ? message.staticAccountKeys
          .map(keyText)
          .filter((value): value is string => !!value)
      : [];
  if (
    staticKeys.length > 0 &&
    staticKeys.length === (tx.meta?.preBalances.length ?? 0)
  ) {
    return staticKeys;
  }
  const loaded = tx.meta?.loadedAddresses;
  const writable = Array.isArray(loaded?.writable)
    ? loaded!.writable.map(keyText).filter((value): value is string => !!value)
    : [];
  const readonly = Array.isArray(loaded?.readonly)
    ? loaded!.readonly.map(keyText).filter((value): value is string => !!value)
    : [];
  return [...staticKeys, ...writable, ...readonly];
}

function instructionAccounts(value: unknown): string[] {
  const accounts = (value as { accounts?: unknown[] } | null)?.accounts;
  return Array.isArray(accounts)
    ? accounts.map(keyText).filter((item): item is string => !!item)
    : [];
}

function instructionProgramId(value: unknown): string | null {
  return keyText((value as { programId?: unknown } | null)?.programId);
}

function instructionData(value: unknown): Buffer | null {
  const data = (value as { data?: unknown } | null)?.data;
  if (typeof data !== "string") return null;
  try {
    return Buffer.from(bs58.decode(data));
  } catch {
    return null;
  }
}

function startsWith(data: Buffer, discriminator: Buffer): boolean {
  return (
    data.length >= discriminator.length &&
    data.subarray(0, discriminator.length).equals(discriminator)
  );
}

type PumpSwapFeeEvent = {
  side: "buy" | "sell";
  pool: string;
  user: string;
  userQuoteAmountRaw: bigint;
  lpFeeQuoteRaw: bigint;
  protocolFeeQuoteRaw: bigint;
  creatorFeeQuoteRaw: bigint | null;
  cashbackQuoteRaw: bigint | null;
  buybackFeeQuoteRaw: bigint | null;
  holderRewardsQuoteRaw: bigint | null;
};

class EventCursor {
  private offset: number;
  constructor(
    private readonly data: Buffer,
    offset = 0,
  ) {
    this.offset = offset;
  }
  remaining(): number {
    return this.data.length - this.offset;
  }
  skip(bytes: number): void {
    if (this.remaining() < bytes) throw new Error("truncated PumpSwap event");
    this.offset += bytes;
  }
  u64(): bigint {
    if (this.remaining() < 8) throw new Error("truncated PumpSwap u64");
    const value = this.data.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }
  i64(): bigint {
    if (this.remaining() < 8) throw new Error("truncated PumpSwap i64");
    const value = this.data.readBigInt64LE(this.offset);
    this.offset += 8;
    return value;
  }
  bool(): boolean {
    if (this.remaining() < 1) throw new Error("truncated PumpSwap bool");
    return this.data[this.offset++]! !== 0;
  }
  pubkey(): string {
    if (this.remaining() < 32) throw new Error("truncated PumpSwap pubkey");
    const value = bs58.encode(
      this.data.subarray(this.offset, this.offset + 32),
    );
    this.offset += 32;
    return value;
  }
  string(): string {
    if (this.remaining() < 4) throw new Error("truncated PumpSwap string");
    const length = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    if (this.remaining() < length)
      throw new Error("truncated PumpSwap string body");
    const value = this.data
      .subarray(this.offset, this.offset + length)
      .toString("utf8");
    this.offset += length;
    return value;
  }
}

function optionalTail<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function parsePumpSwapBuyEvent(data: Buffer): PumpSwapFeeEvent | null {
  if (!startsWith(data, AMM_BUY_EVENT_D8)) return null;
  try {
    const cursor = new EventCursor(data, AMM_BUY_EVENT_D8.length);
    cursor.i64();
    cursor.u64();
    cursor.u64();
    cursor.u64();
    cursor.u64();
    cursor.u64();
    cursor.u64();
    cursor.u64();
    cursor.u64();
    const lpFeeQuoteRaw = cursor.u64();
    cursor.u64();
    const protocolFeeQuoteRaw = cursor.u64();
    cursor.u64();
    const userQuoteAmountRaw = cursor.u64();
    const pool = cursor.pubkey();
    const user = cursor.pubkey();
    cursor.pubkey();
    cursor.pubkey();
    cursor.pubkey();
    cursor.pubkey();

    let creatorFeeQuoteRaw: bigint | null = null;
    let cashbackQuoteRaw: bigint | null = null;
    let buybackFeeQuoteRaw: bigint | null = null;
    let holderRewardsQuoteRaw: bigint | null = null;
    if (cursor.remaining() >= 48) {
      optionalTail(() => {
        cursor.pubkey();
        cursor.u64();
        creatorFeeQuoteRaw = cursor.u64();
        cursor.bool();
        cursor.u64();
        cursor.u64();
        cursor.u64();
        cursor.i64();
        cursor.u64();
        cursor.string();
        cursor.u64();
        cashbackQuoteRaw = cursor.u64();
        cursor.u64();
        buybackFeeQuoteRaw = cursor.u64();
        cursor.skip(16);
        cursor.bool();
        cursor.u64();
        cursor.u64();
        holderRewardsQuoteRaw = cursor.u64();
      });
    }
    return {
      side: "buy",
      pool,
      user,
      userQuoteAmountRaw,
      lpFeeQuoteRaw,
      protocolFeeQuoteRaw,
      creatorFeeQuoteRaw,
      cashbackQuoteRaw,
      buybackFeeQuoteRaw,
      holderRewardsQuoteRaw,
    };
  } catch {
    return null;
  }
}

function parsePumpSwapSellEvent(data: Buffer): PumpSwapFeeEvent | null {
  if (!startsWith(data, AMM_SELL_EVENT_D8)) return null;
  try {
    const cursor = new EventCursor(data, AMM_SELL_EVENT_D8.length);
    cursor.i64();
    cursor.u64();
    cursor.u64();
    cursor.u64();
    cursor.u64();
    cursor.u64();
    cursor.u64();
    cursor.u64();
    cursor.u64();
    const lpFeeQuoteRaw = cursor.u64();
    cursor.u64();
    const protocolFeeQuoteRaw = cursor.u64();
    cursor.u64();
    const userQuoteAmountRaw = cursor.u64();
    const pool = cursor.pubkey();
    const user = cursor.pubkey();
    cursor.pubkey();
    cursor.pubkey();
    cursor.pubkey();
    cursor.pubkey();

    let creatorFeeQuoteRaw: bigint | null = null;
    let cashbackQuoteRaw: bigint | null = null;
    let buybackFeeQuoteRaw: bigint | null = null;
    let holderRewardsQuoteRaw: bigint | null = null;
    if (cursor.remaining() >= 48) {
      optionalTail(() => {
        cursor.pubkey();
        cursor.u64();
        creatorFeeQuoteRaw = cursor.u64();
        cursor.u64();
        cashbackQuoteRaw = cursor.u64();
        cursor.u64();
        buybackFeeQuoteRaw = cursor.u64();
        cursor.skip(16);
        cursor.bool();
        cursor.u64();
        cursor.u64();
        holderRewardsQuoteRaw = cursor.u64();
      });
    }
    return {
      side: "sell",
      pool,
      user,
      userQuoteAmountRaw,
      lpFeeQuoteRaw,
      protocolFeeQuoteRaw,
      creatorFeeQuoteRaw,
      cashbackQuoteRaw,
      buybackFeeQuoteRaw,
      holderRewardsQuoteRaw,
    };
  } catch {
    return null;
  }
}

function pumpSwapFeeEvents(tx: ParsedTransactionWithMeta): PumpSwapFeeEvent[] {
  const logs = tx.meta?.logMessages ?? [];
  const stack: string[] = [];
  const out: PumpSwapFeeEvent[] = [];
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      stack.length = Math.max(0, depth - 1);
      stack.push(invoke[1]!);
      continue;
    }
    const done = /^Program (\S+) (?:success|failed:.*)$/.exec(line);
    if (done) {
      const index = stack.lastIndexOf(done[1]!);
      if (index >= 0) stack.length = index;
      continue;
    }
    if (stack.at(-1) !== PUMP_AMM_PROGRAM_ID.toBase58()) continue;
    const prefix = "Program data: ";
    if (!line.startsWith(prefix)) continue;
    try {
      const data = Buffer.from(line.slice(prefix.length), "base64");
      const parsed =
        parsePumpSwapBuyEvent(data) ?? parsePumpSwapSellEvent(data);
      if (parsed) out.push(parsed);
    } catch {
      // Ignore malformed logs. Exact fee data is omitted rather than estimated.
    }
  }
  return out;
}

function sumRequired(
  rows: readonly PumpSwapFeeEvent[],
  field: "userQuoteAmountRaw" | "lpFeeQuoteRaw" | "protocolFeeQuoteRaw",
): bigint {
  return rows.reduce((sum, row) => sum + row[field], 0n);
}

function sumOptional(
  rows: readonly PumpSwapFeeEvent[],
  field:
    | "creatorFeeQuoteRaw"
    | "cashbackQuoteRaw"
    | "buybackFeeQuoteRaw"
    | "holderRewardsQuoteRaw",
): bigint | null {
  let total = 0n;
  for (const row of rows) {
    const value = row[field];
    if (value == null) return null;
    total += value;
  }
  return total;
}

function pumpSwapFeeBreakdown(
  group: readonly ClassifiedInstruction[],
  events: readonly PumpSwapFeeEvent[],
): PumpSwapFeeBreakdown | undefined {
  const first = group[0];
  if (!first || first.venue !== "pumpswap" || !first.pool || !first.quoteMint)
    return undefined;
  const pools = new Set(group.map((row) => row.pool).filter(Boolean));
  const quoteMints = new Set(group.map((row) => row.quoteMint).filter(Boolean));
  if (quoteMints.size !== 1) return undefined;
  const matching = events.filter(
    (event) =>
      event.side === first.side &&
      event.user === first.user &&
      pools.has(event.pool),
  );
  if (matching.length !== group.length) return undefined;
  return {
    source: "anchor-event",
    eventCount: matching.length,
    quoteMint: first.quoteMint,
    userQuoteAmountRaw: sumRequired(matching, "userQuoteAmountRaw").toString(),
    lpFeeQuoteRaw: sumRequired(matching, "lpFeeQuoteRaw").toString(),
    protocolFeeQuoteRaw: sumRequired(
      matching,
      "protocolFeeQuoteRaw",
    ).toString(),
    creatorFeeQuoteRaw:
      sumOptional(matching, "creatorFeeQuoteRaw")?.toString() ?? null,
    cashbackQuoteRaw:
      sumOptional(matching, "cashbackQuoteRaw")?.toString() ?? null,
    buybackFeeQuoteRaw:
      sumOptional(matching, "buybackFeeQuoteRaw")?.toString() ?? null,
    holderRewardsQuoteRaw:
      sumOptional(matching, "holderRewardsQuoteRaw")?.toString() ?? null,
  };
}

function collectInstructions(tx: ParsedTransactionWithMeta): Array<{
  value: unknown;
  index: number;
}> {
  const out: Array<{ value: unknown; index: number }> = [];
  let index = 0;
  const outer = (
    tx.transaction.message as unknown as { instructions?: unknown[] }
  ).instructions;
  for (const value of Array.isArray(outer) ? outer : []) {
    out.push({ value, index: index++ });
  }
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const value of group.instructions ?? []) {
      out.push({ value, index: index++ });
    }
  }
  return out;
}

function classifyInstruction(
  value: unknown,
  index: number,
  targetMint: string,
): ClassifiedInstruction | null {
  const programId = instructionProgramId(value);
  const data = instructionData(value);
  const accounts = instructionAccounts(value);
  if (!programId || !data || !accounts.length) return null;

  if (programId === PUMP_PROGRAM_ID.toBase58()) {
    const mint = accounts[1] ?? null;
    const user = accounts[13] ?? null;
    if (mint !== targetMint || !user) return null;
    if (startsWith(data, BUY_EXACT_QUOTE_IN_V2_D8)) {
      return {
        venue: "pump-curve",
        side: "buy",
        kind: "buy_exact_quote_in_v2",
        user,
        mint,
        pool: null,
        quoteMint: NATIVE_MINT.toBase58(),
        index,
        data,
        protectedNativeDestinations: [accounts[15]!].filter(Boolean),
      };
    }
    if (startsWith(data, SELL_V2_D8)) {
      return {
        venue: "pump-curve",
        side: "sell",
        kind: "sell_v2",
        user,
        mint,
        pool: null,
        quoteMint: NATIVE_MINT.toBase58(),
        index,
        data,
        protectedNativeDestinations: [accounts[15]!].filter(Boolean),
      };
    }
    return null;
  }

  if (programId === PUMP_AMM_PROGRAM_ID.toBase58()) {
    const user = accounts[1] ?? null;
    const mint = accounts[3] ?? null;
    if (mint !== targetMint || !user) return null;
    if (startsWith(data, AMM_BUY_EXACT_QUOTE_IN_D8)) {
      return {
        venue: "pumpswap",
        side: "buy",
        kind: "buy_exact_quote_in",
        user,
        mint,
        pool: accounts[0] ?? null,
        quoteMint: accounts[4] ?? null,
        index,
        data,
        protectedNativeDestinations: [accounts[6]!].filter(Boolean),
      };
    }
    if (startsWith(data, AMM_BUY_D8)) {
      return {
        venue: "pumpswap",
        side: "buy",
        kind: "buy",
        user,
        mint,
        pool: accounts[0] ?? null,
        quoteMint: accounts[4] ?? null,
        index,
        data,
        protectedNativeDestinations: [accounts[6]!].filter(Boolean),
      };
    }
    if (startsWith(data, AMM_SELL_D8)) {
      return {
        venue: "pumpswap",
        side: "sell",
        kind: "sell",
        user,
        mint,
        pool: accounts[0] ?? null,
        quoteMint: accounts[4] ?? null,
        index,
        data,
        protectedNativeDestinations: [accounts[6]!].filter(Boolean),
      };
    }
  }
  return null;
}

function rawU64(data: Buffer, offset: number): bigint | null {
  return offset + 8 <= data.length ? data.readBigUInt64LE(offset) : null;
}

function instructionInputFallback(
  group: ClassifiedInstruction[],
): bigint | null {
  if (!group.length || group[0]!.side !== "buy") return null;
  let total = 0n;
  for (const ix of group) {
    let value: bigint | null = null;
    if (
      ix.kind === "buy_exact_quote_in_v2" ||
      ix.kind === "buy_exact_quote_in"
    ) {
      value = rawU64(ix.data, 8);
    }
    // Legacy PumpSwap `buy` carries max quote input rather than actual quote input,
    // so it is deliberately not used as a price fallback.
    if (value == null) return null;
    total += value;
  }
  return total > 0n ? total : null;
}

function normalizeTokenBalances(rows: unknown): TokenBalanceRow[] {
  if (!Array.isArray(rows)) return [];
  const out: TokenBalanceRow[] = [];
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as {
      accountIndex?: unknown;
      mint?: unknown;
      owner?: unknown;
      uiTokenAmount?: { amount?: unknown };
    };
    const accountIndex = Number(row.accountIndex);
    const mint = typeof row.mint === "string" ? row.mint : null;
    const owner = typeof row.owner === "string" ? row.owner : null;
    const amount = row.uiTokenAmount?.amount;
    if (
      !Number.isInteger(accountIndex) ||
      !mint ||
      typeof amount !== "string"
    ) {
      continue;
    }
    try {
      out.push({ accountIndex, mint, owner, raw: BigInt(amount) });
    } catch {
      // malformed RPC balance row
    }
  }
  return out;
}

function ownerTokenDeltaRaw(
  tx: ParsedTransactionWithMeta,
  mint: string,
  owner: string,
): bigint {
  const pre = normalizeTokenBalances(tx.meta?.preTokenBalances);
  const post = normalizeTokenBalances(tx.meta?.postTokenBalances);
  const total = (rows: TokenBalanceRow[]) =>
    rows
      .filter((row) => row.mint === mint && row.owner === owner)
      .reduce((sum, row) => sum + row.raw, 0n);
  return total(post) - total(pre);
}

function ownerTokenAccountRentDeltaLamports(
  tx: ParsedTransactionWithMeta,
  owner: string,
): bigint {
  const preRows = normalizeTokenBalances(tx.meta?.preTokenBalances);
  const postRows = normalizeTokenBalances(tx.meta?.postTokenBalances);
  const byIndex = new Map<
    number,
    { pre?: TokenBalanceRow; post?: TokenBalanceRow }
  >();
  for (const row of preRows) {
    const pair = byIndex.get(row.accountIndex) ?? {};
    pair.pre = row;
    byIndex.set(row.accountIndex, pair);
  }
  for (const row of postRows) {
    const pair = byIndex.get(row.accountIndex) ?? {};
    pair.post = row;
    byIndex.set(row.accountIndex, pair);
  }

  const preBalances = tx.meta?.preBalances ?? [];
  const postBalances = tx.meta?.postBalances ?? [];
  let total = 0n;
  for (const [index, pair] of byIndex) {
    const balanceOwner = pair.post?.owner ?? pair.pre?.owner ?? null;
    if (balanceOwner !== owner) continue;
    const preLamports = BigInt(Math.trunc(Number(preBalances[index] ?? 0)));
    const postLamports = BigInt(Math.trunc(Number(postBalances[index] ?? 0)));
    let accountLamportDelta = postLamports - preLamports;
    const mint = pair.post?.mint ?? pair.pre?.mint;
    if (mint === NATIVE_MINT.toBase58()) {
      const tokenDelta = (pair.post?.raw ?? 0n) - (pair.pre?.raw ?? 0n);
      accountLamportDelta -= tokenDelta;
    }
    total += accountLamportDelta;
  }
  return total;
}

function outerExternalNativeTransferOutLamports(
  tx: ParsedTransactionWithMeta,
  owner: string,
  protectedDestinations: Set<string>,
): bigint {
  const outer = (
    tx.transaction.message as unknown as { instructions?: unknown[] }
  ).instructions;
  let total = 0n;
  for (const value of Array.isArray(outer) ? outer : []) {
    const row = value as {
      program?: unknown;
      parsed?: { type?: unknown; info?: Record<string, unknown> };
    };
    if (row.program !== "system" || row.parsed?.type !== "transfer") continue;
    const info = row.parsed.info ?? {};
    const source =
      keyText(info.source) ??
      (typeof info.source === "string" ? info.source : null);
    const destination =
      keyText(info.destination) ??
      (typeof info.destination === "string" ? info.destination : null);
    if (
      source !== owner ||
      !destination ||
      protectedDestinations.has(destination)
    ) {
      continue;
    }
    const raw = info.lamports;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      total += BigInt(Math.trunc(raw));
    } else if (typeof raw === "string") {
      try {
        const parsed = BigInt(raw);
        if (parsed > 0n) total += parsed;
      } catch {}
    }
  }
  return total;
}

function economicQuoteDeltaLamports(
  tx: ParsedTransactionWithMeta,
  owner: string,
  protectedDestinations: Set<string>,
): {
  economic: bigint | null;
  nativeWalletDelta: bigint | null;
  feeLamports: bigint;
  tokenAccountRentDelta: bigint;
  wsolDelta: bigint;
  excludedExternalTransfers: bigint;
} {
  const keys = accountKeys(tx);
  const index = keys.indexOf(owner);
  if (index < 0 || !tx.meta) {
    return {
      economic: null,
      nativeWalletDelta: null,
      feeLamports: 0n,
      tokenAccountRentDelta: 0n,
      wsolDelta: ownerTokenDeltaRaw(tx, NATIVE_MINT.toBase58(), owner),
      excludedExternalTransfers: 0n,
    };
  }
  const pre = tx.meta.preBalances[index];
  const post = tx.meta.postBalances[index];
  if (pre == null || post == null) {
    return {
      economic: null,
      nativeWalletDelta: null,
      feeLamports: 0n,
      tokenAccountRentDelta: 0n,
      wsolDelta: ownerTokenDeltaRaw(tx, NATIVE_MINT.toBase58(), owner),
      excludedExternalTransfers: 0n,
    };
  }
  const nativeWalletDelta =
    BigInt(Math.trunc(Number(post))) - BigInt(Math.trunc(Number(pre)));
  const feeLamports = keys[0] === owner ? BigInt(tx.meta.fee ?? 0) : 0n;
  const tokenAccountRentDelta = ownerTokenAccountRentDeltaLamports(tx, owner);
  const wsolDelta = ownerTokenDeltaRaw(tx, NATIVE_MINT.toBase58(), owner);
  const excludedExternalTransfers = outerExternalNativeTransferOutLamports(
    tx,
    owner,
    protectedDestinations,
  );
  return {
    nativeWalletDelta,
    feeLamports,
    tokenAccountRentDelta,
    wsolDelta,
    excludedExternalTransfers,
    economic:
      nativeWalletDelta +
      feeLamports +
      tokenAccountRentDelta +
      wsolDelta +
      excludedExternalTransfers,
  };
}

export function findPumpHistoryCreateMarker(
  tx: ParsedTransactionWithMeta,
  signature: string,
  targetMint: string,
): {
  signature: string;
  slot: number;
  atMs: number | null;
  name: string | null;
  symbol: string | null;
} | null {
  for (const { value } of collectInstructions(tx)) {
    if (instructionProgramId(value) !== PUMP_PROGRAM_ID.toBase58()) continue;
    const data = instructionData(value);
    const accounts = instructionAccounts(value);
    if (!data || accounts[0] !== targetMint) continue;
    if (
      !startsWith(data, CREATE_V2_D8) &&
      !startsWith(data, LEGACY_CREATE_D8)
    ) {
      continue;
    }
    let decoded: Partial<Record<string, unknown>> | null = null;
    const encoded = (value as { data?: unknown }).data;
    if (typeof encoded === "string") decoded = parsePumpCreateData(encoded);
    return {
      signature,
      slot: tx.slot,
      atMs: tx.blockTime == null ? null : tx.blockTime * 1_000,
      name: typeof decoded?.name === "string" ? decoded.name : null,
      symbol: typeof decoded?.symbol === "string" ? decoded.symbol : null,
    };
  }
  return null;
}

export function parsePumpHistoryTransaction(args: {
  tx: ParsedTransactionWithMeta;
  signature: string;
  mint: string;
  decimals: number;
  supplyUi: number;
  historyOrder: number;
  scanAddress: string;
  scanKind: "curve" | "pool";
  confidence: "confirmed" | "finalized";
  updatedAtMs?: number;
}): {
  trades: TokenHistoryTrade[];
  ambiguous: number;
} {
  const { tx } = args;
  if (!tx.meta || tx.meta.err) return { trades: [], ambiguous: 0 };
  if (tx.blockTime == null) return { trades: [], ambiguous: 0 };

  const feeEvents = pumpSwapFeeEvents(tx);
  const classified = collectInstructions(tx)
    .map(({ value, index }) => classifyInstruction(value, index, args.mint))
    .filter((item): item is ClassifiedInstruction => item != null);
  if (!classified.length) return { trades: [], ambiguous: 0 };

  const sidesByUser = new Map<string, Set<TokenHistorySide>>();
  for (const ix of classified) {
    const set = sidesByUser.get(ix.user) ?? new Set<TokenHistorySide>();
    set.add(ix.side);
    sidesByUser.set(ix.user, set);
  }

  const groups = new Map<string, ClassifiedInstruction[]>();
  let ambiguous = 0;
  for (const ix of classified) {
    if ((sidesByUser.get(ix.user)?.size ?? 0) > 1) {
      ambiguous += 1;
      continue;
    }
    const key = `${ix.venue}|${ix.side}|${ix.user}`;
    const group = groups.get(key) ?? [];
    group.push(ix);
    groups.set(key, group);
  }

  const trades: TokenHistoryTrade[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const signedTokenDelta = ownerTokenDeltaRaw(tx, args.mint, first.user);
    if (
      signedTokenDelta === 0n ||
      (first.side === "buy" && signedTokenDelta < 0n) ||
      (first.side === "sell" && signedTokenDelta > 0n)
    ) {
      ambiguous += 1;
      continue;
    }

    const protectedDestinations = new Set(
      group.flatMap((ix) => ix.protectedNativeDestinations),
    );
    const economics = economicQuoteDeltaLamports(
      tx,
      first.user,
      protectedDestinations,
    );
    const expectedSign = first.side === "buy" ? -1n : 1n;
    let quoteDelta = economics.economic;
    let pricingStatus: TokenHistoryRaw["pricingStatus"] =
      "native-wsol-corrected";
    if (quoteDelta == null || quoteDelta * expectedSign <= 0n) {
      const fallback = instructionInputFallback(group);
      if (first.side === "buy" && fallback != null) {
        quoteDelta = -fallback;
        pricingStatus = "instruction-input-fallback";
      } else {
        quoteDelta = null;
        pricingStatus = "missing";
      }
    }

    const tokenRawAbs =
      signedTokenDelta < 0n ? -signedTokenDelta : signedTokenDelta;
    const tokenUi = Number(tokenRawAbs) / 10 ** args.decimals;
    const solUi =
      quoteDelta == null
        ? 0
        : Number(quoteDelta < 0n ? -quoteDelta : quoteDelta) / LAMPORTS_PER_SOL;
    const priceSol = tokenUi > 0 && solUi > 0 ? solUi / tokenUi : null;
    const marketCapSol =
      priceSol != null && args.supplyUi > 0 ? priceSol * args.supplyUi : null;
    const exactPumpSwapFees = pumpSwapFeeBreakdown(group, feeEvents);
    const raw: TokenHistoryRaw = {
      parserVersion: HISTORY_PARSER_VERSION,
      venue: first.venue,
      instructionKinds: group.map((ix) => ix.kind),
      instructionIndex: Math.min(...group.map((ix) => ix.index)),
      historyOrder: args.historyOrder,
      scanAddress: args.scanAddress,
      scanKind: args.scanKind,
      ownerTokenDeltaRaw: signedTokenDelta.toString(),
      nativeWalletDeltaLamports:
        economics.nativeWalletDelta?.toString() ?? null,
      networkFeeLamports: economics.feeLamports.toString(),
      tokenAccountRentDeltaLamports: economics.tokenAccountRentDelta.toString(),
      wsolDeltaRaw: economics.wsolDelta.toString(),
      economicQuoteDeltaLamports: quoteDelta?.toString() ?? null,
      pricingStatus,
      excludedExternalTransfersLamports:
        economics.excludedExternalTransfers.toString(),
      marketCapSol,
      ...(exactPumpSwapFees ? { pumpSwapFees: exactPumpSwapFees } : {}),
    };
    const eventKey = [
      "token-history-v1",
      args.signature,
      args.mint,
      first.venue,
      first.side,
      first.user,
    ].join(":");
    // Deterministic fallback: parser output must not depend on wall-clock time.
    const now = args.updatedAtMs ?? tx.blockTime * 1_000;
    trades.push({
      eventKey,
      mint: args.mint,
      signature: args.signature,
      slot: tx.slot,
      owner: first.user,
      side: first.side,
      tokenDeltaUi: tokenUi,
      solDeltaUi: solUi,
      priceSol,
      priceUsd: null,
      marketCapUsd: null,
      confidence: args.confidence,
      source: `history:${first.venue}`,
      rawJson: JSON.stringify(raw),
      tradedAtMs: tx.blockTime * 1_000,
      updatedAtMs: now,
      history: raw,
    });
  }
  return { trades, ambiguous };
}
