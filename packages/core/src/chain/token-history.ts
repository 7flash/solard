import { NATIVE_MINT } from "@solana/spl-token";
import {
  PublicKey,
  type ConfirmedSignatureInfo,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import bs58 from "bs58";
import { Buffer } from "buffer";

import { readMint } from "./state.ts";
import {
  db,
  TokenTradeSchema,
  type TokenTrade,
  upsertProcessStatus,
} from "../db.ts";
import { parsePumpCreateData } from "../pump/parsers/pump-create.ts";
import {
  AMM_BUY_D8,
  AMM_BUY_EXACT_QUOTE_IN_D8,
  AMM_SELL_D8,
  BUY_EXACT_QUOTE_IN_V2_D8,
  CREATE_V2_D8,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SELL_V2_D8,
} from "../venues/pump/constants.ts";
import { PumpCurveVenue } from "../venues/pump/pump-curve-venue.ts";

const HISTORY_PARSER_VERSION = "pump-history-v1";
const HISTORY_STATUS_PREFIX = "token-history:";
const LEGACY_CREATE_D8 = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);
const LAMPORTS_PER_SOL = 1_000_000_000;

export type TokenHistoryVenue = "pump-curve" | "pumpswap";
export type TokenHistorySide = "buy" | "sell";

export type TokenHistoryRaw = {
  parserVersion: string;
  venue: TokenHistoryVenue;
  instructionKinds: string[];
  instructionIndex: number;
  historyOrder: number;
  scanAddress: string;
  scanKind: "curve" | "pool";
  ownerTokenDeltaRaw: string;
  nativeWalletDeltaLamports: string | null;
  networkFeeLamports: string;
  tokenAccountRentDeltaLamports: string;
  wsolDeltaRaw: string;
  economicQuoteDeltaLamports: string | null;
  pricingStatus:
    "native-wsol-corrected" | "instruction-input-fallback" | "missing";
  excludedExternalTransfersLamports: string;
  marketCapSol: number | null;
};

export type TokenHistoryCoverage = {
  version: 1;
  mint: string;
  quoteMint: string;
  decimals: number;
  supplyRaw: string;
  supplyUi: number;
  bondingCurve: string;
  pool: string | null;
  commitment: "confirmed" | "finalized";
  curve: AddressHistoryCoverage;
  pumpswap: AddressHistoryCoverage | null;
  uniqueSignatures: number;
  parsedTransactions: number;
  missingTransactions: number;
  failedTransactions: number;
  skippedNoTimestamp: number;
  skippedAmbiguous: number;
  storedTrades: number;
  insertedTrades: number;
  updatedTrades: number;
  creationSignature: string | null;
  creationAtMs: number | null;
  creationSlot: number | null;
  creationName: string | null;
  creationSymbol: string | null;
  fromCreation: boolean;
  complete: boolean;
  updatedAtMs: number;
};

export type AddressHistoryCoverage = {
  kind: "curve" | "pool";
  address: string;
  pages: number;
  signatures: number;
  oldestSignature: string | null;
  oldestSlot: number | null;
  oldestBlockTime: number | null;
  newestSignature: string | null;
  newestSlot: number | null;
  newestBlockTime: number | null;
  reachedStart: boolean;
  truncated: boolean;
};

export type TokenHistoryBackfillProgress =
  | {
      phase: "signatures";
      kind: "curve" | "pool";
      address: string;
      pages: number;
      signatures: number;
    }
  | {
      phase: "transactions";
      completed: number;
      total: number;
      batchSize: number;
    }
  | {
      phase: "store";
      completed: number;
      total: number;
      inserted: number;
      updated: number;
    };

export type BackfillTokenHistoryOptions = {
  commitment?: "confirmed" | "finalized";
  pageSize?: number;
  transactionBatchSize?: number;
  rpcTimeoutMs?: number;
  rpcRetries?: number;
  retryDelayMs?: number;
  maxSignaturesPerAddress?: number;
  replace?: boolean;
  onProgress?: (progress: TokenHistoryBackfillProgress) => void;
};

export type TokenHistoryTrade = TokenTrade & {
  history: TokenHistoryRaw;
};

export type TokenHistoryAnalysis = {
  mint: string;
  coverage: TokenHistoryCoverage | null;
  trades: number;
  buys: number;
  sells: number;
  uniqueTraders: number;
  buySol: number;
  sellSol: number;
  netInflowSol: number;
  firstTradeAtMs: number | null;
  lastTradeAtMs: number | null;
  firstExternalBuyer: TokenHistoryTrade | null;
  athPriceSol: number | null;
  atlPriceSol: number | null;
  athMarketCapSol: number | null;
  atlMarketCapSol: number | null;
  roundTripTraders: number;
  owners: Array<{
    owner: string;
    buySol: number;
    sellSol: number;
    netSpentSol: number;
    boughtTokens: number;
    soldTokens: number;
    netTokens: number;
    buys: number;
    sells: number;
    trades: number;
    firstTradeAtMs: number;
    lastTradeAtMs: number;
  }>;
};

type ScanSignature = ConfirmedSignatureInfo & {
  scanKind: "curve" | "pool";
  scanAddress: string;
  localChronologicalOrder: number;
};

type ClassifiedInstruction = {
  venue: TokenHistoryVenue;
  side: TokenHistorySide;
  kind: string;
  user: string;
  mint: string;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
}): {
  trades: TokenHistoryTrade[];
  ambiguous: number;
} {
  const { tx } = args;
  if (!tx.meta || tx.meta.err) return { trades: [], ambiguous: 0 };
  if (tx.blockTime == null) return { trades: [], ambiguous: 0 };

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
    };
    const eventKey = [
      "token-history-v1",
      args.signature,
      args.mint,
      first.venue,
      first.side,
      first.user,
    ].join(":");
    const now = Date.now();
    const parsed = TokenTradeSchema.parse({
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
    }) as TokenTrade;
    trades.push({ ...parsed, history: raw });
  }
  return { trades, ambiguous };
}

function parseHistoryRaw(rawJson: string): TokenHistoryRaw {
  try {
    const raw = JSON.parse(rawJson) as Partial<TokenHistoryRaw>;
    return {
      parserVersion: String(raw.parserVersion ?? "unknown"),
      venue: raw.venue === "pumpswap" ? "pumpswap" : "pump-curve",
      instructionKinds: Array.isArray(raw.instructionKinds)
        ? raw.instructionKinds.map(String)
        : [],
      instructionIndex: Number(raw.instructionIndex ?? 0),
      historyOrder: Number(raw.historyOrder ?? 0),
      scanAddress: String(raw.scanAddress ?? ""),
      scanKind: raw.scanKind === "pool" ? "pool" : "curve",
      ownerTokenDeltaRaw: String(raw.ownerTokenDeltaRaw ?? "0"),
      nativeWalletDeltaLamports:
        raw.nativeWalletDeltaLamports == null
          ? null
          : String(raw.nativeWalletDeltaLamports),
      networkFeeLamports: String(raw.networkFeeLamports ?? "0"),
      tokenAccountRentDeltaLamports: String(
        raw.tokenAccountRentDeltaLamports ?? "0",
      ),
      wsolDeltaRaw: String(raw.wsolDeltaRaw ?? "0"),
      economicQuoteDeltaLamports:
        raw.economicQuoteDeltaLamports == null
          ? null
          : String(raw.economicQuoteDeltaLamports),
      pricingStatus:
        raw.pricingStatus === "instruction-input-fallback" ||
        raw.pricingStatus === "missing"
          ? raw.pricingStatus
          : "native-wsol-corrected",
      excludedExternalTransfersLamports: String(
        raw.excludedExternalTransfersLamports ?? "0",
      ),
      marketCapSol:
        typeof raw.marketCapSol === "number" &&
        Number.isFinite(raw.marketCapSol)
          ? raw.marketCapSol
          : null,
    };
  } catch {
    return {
      parserVersion: "unknown",
      venue: "pump-curve",
      instructionKinds: [],
      instructionIndex: 0,
      historyOrder: 0,
      scanAddress: "",
      scanKind: "curve",
      ownerTokenDeltaRaw: "0",
      nativeWalletDeltaLamports: null,
      networkFeeLamports: "0",
      tokenAccountRentDeltaLamports: "0",
      wsolDeltaRaw: "0",
      economicQuoteDeltaLamports: null,
      pricingStatus: "missing",
      excludedExternalTransfersLamports: "0",
      marketCapSol: null,
    };
  }
}

function historySort(
  left: TokenHistoryTrade,
  right: TokenHistoryTrade,
): number {
  return (
    left.tradedAtMs - right.tradedAtMs ||
    left.slot - right.slot ||
    left.history.historyOrder - right.history.historyOrder ||
    left.history.instructionIndex - right.history.instructionIndex ||
    left.eventKey.localeCompare(right.eventKey)
  );
}

export function loadTokenHistoryTrades(mintInput: string): TokenHistoryTrade[] {
  const mint = mintInput.trim();
  if (!mint) throw new Error("Token mint is required");
  const rows = db.tokenHistoryTradesV1
    .select()
    .where({ mint })
    .all() as TokenTrade[];
  return rows
    .map((row) => ({ ...row, history: parseHistoryRaw(row.rawJson) }))
    .sort(historySort);
}

export function getTokenHistoryCoverage(
  mintInput: string,
): TokenHistoryCoverage | null {
  const mint = mintInput.trim();
  if (!mint) return null;
  const row = db.processStatus
    .select()
    .where({ name: `${HISTORY_STATUS_PREFIX}${mint}` })
    .get() as { dataJson?: string } | null;
  if (!row?.dataJson) return null;
  try {
    const parsed = JSON.parse(row.dataJson) as {
      coverage?: TokenHistoryCoverage;
    };
    return parsed.coverage ?? null;
  } catch {
    return null;
  }
}

async function scanAddress(
  connection: Connection,
  kind: "curve" | "pool",
  address: PublicKey,
  options: Required<
    Pick<
      BackfillTokenHistoryOptions,
      | "pageSize"
      | "rpcTimeoutMs"
      | "rpcRetries"
      | "retryDelayMs"
      | "maxSignaturesPerAddress"
    >
  > & {
    commitment: "confirmed" | "finalized";
    onProgress?: BackfillTokenHistoryOptions["onProgress"];
  },
): Promise<{ rows: ScanSignature[]; coverage: AddressHistoryCoverage }> {
  const rows: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  let pages = 0;
  let reachedStart = false;
  let truncated = false;

  while (true) {
    const remaining =
      options.maxSignaturesPerAddress > 0
        ? options.maxSignaturesPerAddress - rows.length
        : options.pageSize;
    if (options.maxSignaturesPerAddress > 0 && remaining <= 0) {
      truncated = true;
      break;
    }
    const limit = Math.min(
      options.pageSize,
      options.maxSignaturesPerAddress > 0 ? remaining : options.pageSize,
    );
    let page: ConfirmedSignatureInfo[] | null = null;
    let lastError = "";
    for (let attempt = 0; attempt <= options.rpcRetries; attempt += 1) {
      try {
        page = await withTimeout(
          () =>
            connection.getSignaturesForAddress(
              address,
              { limit, ...(before ? { before } : {}) },
              options.commitment,
            ),
          options.rpcTimeoutMs,
          `getSignaturesForAddress ${kind} ${address.toBase58()}`,
        );
        break;
      } catch (error) {
        lastError = messageOf(error);
        if (attempt < options.rpcRetries) {
          await sleep(options.retryDelayMs * (attempt + 1));
        }
      }
    }
    if (!page) throw new Error(lastError || `Failed to scan ${kind} history`);
    pages += 1;
    rows.push(...page.filter((item) => !item.err));
    options.onProgress?.({
      phase: "signatures",
      kind,
      address: address.toBase58(),
      pages,
      signatures: rows.length,
    });
    if (page.length < limit) {
      reachedStart = true;
      break;
    }
    const next = page.at(-1)?.signature;
    if (!next || next === before) {
      reachedStart = true;
      break;
    }
    before = next;
  }

  const chronological = [...rows].reverse().map((row, index) => ({
    ...row,
    scanKind: kind,
    scanAddress: address.toBase58(),
    localChronologicalOrder: index,
  }));
  const oldest = chronological[0] ?? null;
  const newest = chronological.at(-1) ?? null;
  return {
    rows: chronological,
    coverage: {
      kind,
      address: address.toBase58(),
      pages,
      signatures: chronological.length,
      oldestSignature: oldest?.signature ?? null,
      oldestSlot: oldest?.slot ?? null,
      oldestBlockTime: oldest?.blockTime ?? null,
      newestSignature: newest?.signature ?? null,
      newestSlot: newest?.slot ?? null,
      newestBlockTime: newest?.blockTime ?? null,
      reachedStart,
      truncated,
    },
  };
}

function mergeScannedSignatures(
  curve: ScanSignature[],
  pool: ScanSignature[],
): ScanSignature[] {
  const unique = new Map<string, ScanSignature>();
  for (const row of [...curve, ...pool]) {
    const previous = unique.get(row.signature);
    if (!previous || row.scanKind === "curve") unique.set(row.signature, row);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.slot - right.slot ||
      (left.blockTime ?? 0) - (right.blockTime ?? 0) ||
      (left.scanKind === right.scanKind
        ? left.localChronologicalOrder - right.localChronologicalOrder
        : left.scanKind === "curve"
          ? -1
          : 1) ||
      left.signature.localeCompare(right.signature),
  );
}

function persistHistoryTrade(row: TokenHistoryTrade): "inserted" | "updated" {
  const existing = db.tokenHistoryTradesV1
    .select()
    .where({ eventKey: row.eventKey })
    .get() as TokenTrade | null;
  if (!existing) {
    db.tokenHistoryTradesV1.insert(row);
    return "inserted";
  }
  db.tokenHistoryTradesV1.upsert(row, {
    on: "eventKey",
    merge: (table) => ({
      slot: table.excluded("slot"),
      owner: table.excluded("owner"),
      side: table.excluded("side"),
      tokenDeltaUi: table.excluded("tokenDeltaUi"),
      solDeltaUi: table.excluded("solDeltaUi"),
      priceSol: table.excluded("priceSol"),
      priceUsd: table.excluded("priceUsd"),
      marketCapUsd: table.excluded("marketCapUsd"),
      confidence: table.excluded("confidence"),
      source: table.excluded("source"),
      rawJson: table.excluded("rawJson"),
      tradedAtMs: table.excluded("tradedAtMs"),
      updatedAtMs: table.excluded("updatedAtMs"),
    }),
  });
  return "updated";
}

export async function backfillTokenHistory(
  connection: Connection,
  mintInput: string,
  input: BackfillTokenHistoryOptions = {},
): Promise<TokenHistoryCoverage> {
  const mint = new PublicKey(mintInput.trim());
  const mintText = mint.toBase58();
  const commitment = input.commitment ?? "finalized";
  const pageSize = Math.max(
    1,
    Math.min(1_000, Math.trunc(input.pageSize ?? 1_000)),
  );
  const transactionBatchSize = Math.max(
    1,
    Math.min(100, Math.trunc(input.transactionBatchSize ?? 25)),
  );
  const rpcTimeoutMs = Math.max(
    1_000,
    Math.trunc(input.rpcTimeoutMs ?? 30_000),
  );
  const rpcRetries = Math.max(
    0,
    Math.min(10, Math.trunc(input.rpcRetries ?? 2)),
  );
  const retryDelayMs = Math.max(100, Math.trunc(input.retryDelayMs ?? 750));
  const maxSignaturesPerAddress = Math.max(
    0,
    Math.trunc(input.maxSignaturesPerAddress ?? 0),
  );

  const mintInfo = await readMint(connection, mint);
  const supplyUi = Number(mintInfo.supply) / 10 ** mintInfo.decimals;
  const inspected = await new PumpCurveVenue().inspectToken(connection, mint);
  if (!inspected?.bondingCurve) {
    throw new Error(`Mint ${mintText} is not a supported Pump token.`);
  }
  if (inspected.quoteMint && inspected.quoteMint !== NATIVE_MINT.toBase58()) {
    throw new Error(
      `Token history v1 supports SOL-paired Pump tokens only; ${mintText} quote mint is ${inspected.quoteMint}.`,
    );
  }

  if (input.replace) {
    db.tokenHistoryTradesV1.delete().where({ mint: mintText }).exec();
  }

  const scanOptions = {
    pageSize,
    rpcTimeoutMs,
    rpcRetries,
    retryDelayMs,
    maxSignaturesPerAddress,
    commitment,
    onProgress: input.onProgress,
  };
  const curve = await scanAddress(
    connection,
    "curve",
    new PublicKey(inspected.bondingCurve),
    scanOptions,
  );
  const pool = inspected.pool
    ? await scanAddress(
        connection,
        "pool",
        new PublicKey(inspected.pool),
        scanOptions,
      )
    : null;
  const signatures = mergeScannedSignatures(curve.rows, pool?.rows ?? []);

  const txBySignature = new Map<string, ParsedTransactionWithMeta>();
  let missingTransactions = 0;
  let failedTransactions = 0;
  for (
    let offset = 0;
    offset < signatures.length;
    offset += transactionBatchSize
  ) {
    const batch = signatures.slice(offset, offset + transactionBatchSize);
    input.onProgress?.({
      phase: "transactions",
      completed: offset,
      total: signatures.length,
      batchSize: batch.length,
    });
    let txs: Array<ParsedTransactionWithMeta | null> | null = null;
    let lastError = "";
    for (let attempt = 0; attempt <= rpcRetries; attempt += 1) {
      try {
        txs = await withTimeout(
          () =>
            connection.getParsedTransactions(
              batch.map((row) => row.signature),
              {
                commitment,
                maxSupportedTransactionVersion: 0,
              },
            ),
          rpcTimeoutMs,
          `getParsedTransactions ${offset + 1}-${offset + batch.length}`,
        );
        break;
      } catch (error) {
        lastError = messageOf(error);
        if (attempt < rpcRetries) await sleep(retryDelayMs * (attempt + 1));
      }
    }
    if (!txs) {
      failedTransactions += batch.length;
      process.stderr.write(
        `[slrd:history] transaction batch failed: ${lastError || "unknown RPC error"}\n`,
      );
      continue;
    }
    for (let index = 0; index < batch.length; index += 1) {
      const tx = txs[index] ?? null;
      if (!tx) {
        missingTransactions += 1;
        continue;
      }
      txBySignature.set(batch[index]!.signature, tx);
    }
  }

  let creation: ReturnType<typeof findPumpHistoryCreateMarker> = null;
  let skippedNoTimestamp = 0;
  let skippedAmbiguous = 0;
  const parsedTrades: TokenHistoryTrade[] = [];
  for (let order = 0; order < signatures.length; order += 1) {
    const scan = signatures[order]!;
    const tx = txBySignature.get(scan.signature);
    if (!tx) continue;
    if (!creation) {
      creation = findPumpHistoryCreateMarker(tx, scan.signature, mintText);
    }
    if (tx.blockTime == null) {
      skippedNoTimestamp += 1;
      continue;
    }
    const parsed = parsePumpHistoryTransaction({
      tx,
      signature: scan.signature,
      mint: mintText,
      decimals: mintInfo.decimals,
      supplyUi,
      historyOrder: order,
      scanAddress: scan.scanAddress,
      scanKind: scan.scanKind,
      confidence: commitment,
    });
    parsedTrades.push(...parsed.trades);
    skippedAmbiguous += parsed.ambiguous;
  }

  let insertedTrades = 0;
  let updatedTrades = 0;
  for (let index = 0; index < parsedTrades.length; index += 1) {
    const state = persistHistoryTrade(parsedTrades[index]!);
    if (state === "inserted") insertedTrades += 1;
    else updatedTrades += 1;
    if (index % 250 === 0 || index + 1 === parsedTrades.length) {
      input.onProgress?.({
        phase: "store",
        completed: index + 1,
        total: parsedTrades.length,
        inserted: insertedTrades,
        updated: updatedTrades,
      });
    }
  }

  const fromCreation = curve.coverage.reachedStart && creation != null;
  const complete =
    fromCreation &&
    !curve.coverage.truncated &&
    (!pool || (pool.coverage.reachedStart && !pool.coverage.truncated)) &&
    missingTransactions === 0 &&
    failedTransactions === 0 &&
    skippedNoTimestamp === 0;
  const coverage: TokenHistoryCoverage = {
    version: 1,
    mint: mintText,
    quoteMint: inspected.quoteMint ?? NATIVE_MINT.toBase58(),
    decimals: mintInfo.decimals,
    supplyRaw: mintInfo.supply.toString(),
    supplyUi,
    bondingCurve: inspected.bondingCurve,
    pool: inspected.pool ?? null,
    commitment,
    curve: curve.coverage,
    pumpswap: pool?.coverage ?? null,
    uniqueSignatures: signatures.length,
    parsedTransactions: txBySignature.size,
    missingTransactions,
    failedTransactions,
    skippedNoTimestamp,
    skippedAmbiguous,
    storedTrades: loadTokenHistoryTrades(mintText).length,
    insertedTrades,
    updatedTrades,
    creationSignature: creation?.signature ?? null,
    creationAtMs: creation?.atMs ?? null,
    creationSlot: creation?.slot ?? null,
    creationName: creation?.name ?? null,
    creationSymbol: creation?.symbol ?? null,
    fromCreation,
    complete,
    updatedAtMs: Date.now(),
  };
  upsertProcessStatus({
    name: `${HISTORY_STATUS_PREFIX}${mintText}`,
    kind: "token-history-backfill",
    status: complete ? "complete" : fromCreation ? "partial" : "incomplete",
    data: { coverage },
  });
  return coverage;
}

export function analyzeTokenHistory(
  mintInput: string,
  options: { ownedWallets?: Iterable<string> } = {},
): TokenHistoryAnalysis {
  const mint = mintInput.trim();
  const trades = loadTokenHistoryTrades(mint);
  const owned = new Set(options.ownedWallets ?? []);
  const owners = new Map<string, TokenHistoryAnalysis["owners"][number]>();
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let sells = 0;
  let athPriceSol: number | null = null;
  let atlPriceSol: number | null = null;
  let athMarketCapSol: number | null = null;
  let atlMarketCapSol: number | null = null;
  let firstExternalBuyer: TokenHistoryTrade | null = null;

  for (const trade of trades) {
    const sol = Math.abs(Number(trade.solDeltaUi));
    const tokens = Math.abs(Number(trade.tokenDeltaUi));
    if (trade.side === "buy") {
      buys += 1;
      buySol += sol;
      if (!firstExternalBuyer && trade.owner && !owned.has(trade.owner)) {
        firstExternalBuyer = trade;
      }
    } else if (trade.side === "sell") {
      sells += 1;
      sellSol += sol;
    }
    if (trade.priceSol != null && trade.priceSol > 0) {
      athPriceSol = Math.max(athPriceSol ?? trade.priceSol, trade.priceSol);
      atlPriceSol = Math.min(atlPriceSol ?? trade.priceSol, trade.priceSol);
    }
    const mcap = trade.history.marketCapSol;
    if (mcap != null && mcap > 0) {
      athMarketCapSol = Math.max(athMarketCapSol ?? mcap, mcap);
      atlMarketCapSol = Math.min(atlMarketCapSol ?? mcap, mcap);
    }
    if (!trade.owner) continue;
    const current = owners.get(trade.owner) ?? {
      owner: trade.owner,
      buySol: 0,
      sellSol: 0,
      netSpentSol: 0,
      boughtTokens: 0,
      soldTokens: 0,
      netTokens: 0,
      buys: 0,
      sells: 0,
      trades: 0,
      firstTradeAtMs: trade.tradedAtMs,
      lastTradeAtMs: trade.tradedAtMs,
    };
    if (trade.side === "buy") {
      current.buySol += sol;
      current.boughtTokens += tokens;
      current.buys += 1;
    } else if (trade.side === "sell") {
      current.sellSol += sol;
      current.soldTokens += tokens;
      current.sells += 1;
    }
    current.trades += 1;
    current.firstTradeAtMs = Math.min(current.firstTradeAtMs, trade.tradedAtMs);
    current.lastTradeAtMs = Math.max(current.lastTradeAtMs, trade.tradedAtMs);
    current.netSpentSol = current.buySol - current.sellSol;
    current.netTokens = current.boughtTokens - current.soldTokens;
    owners.set(trade.owner, current);
  }

  const ownerRows = [...owners.values()].sort(
    (left, right) => right.trades - left.trades || right.buySol - left.buySol,
  );
  return {
    mint,
    coverage: getTokenHistoryCoverage(mint),
    trades: trades.length,
    buys,
    sells,
    uniqueTraders: owners.size,
    buySol,
    sellSol,
    netInflowSol: buySol - sellSol,
    firstTradeAtMs: trades[0]?.tradedAtMs ?? null,
    lastTradeAtMs: trades.at(-1)?.tradedAtMs ?? null,
    firstExternalBuyer,
    athPriceSol,
    atlPriceSol,
    athMarketCapSol,
    atlMarketCapSol,
    roundTripTraders: ownerRows.filter((row) => row.buys > 0 && row.sells > 0)
      .length,
    owners: ownerRows,
  };
}
