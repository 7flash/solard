import { NATIVE_MINT } from "@solana/spl-token";
import {
  PublicKey,
  type Commitment,
  type Connection,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";

import { readMint } from "../chain/state.ts";
import {
  findPumpHistoryCreateMarker,
  parsePumpHistoryTransaction,
} from "../chain/token-history/parser.ts";
import type { TokenRow } from "../db/schema.ts";
import {
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  TOKEN_2022_ID,
  SPL_TOKEN_PROGRAM_ID,
} from "../venues/pump/constants.ts";

export type SolardTokenEventConfidence = "confirmed" | "finalized";

export type SolardTokenSwapEvent = {
  id: string;
  type: "swap";
  mint: string;
  signature: string;
  slot: number;
  observedAtMs: number;
  blockTimeMs: number | null;
  confidence: SolardTokenEventConfidence;
  venue: "pump-curve" | "pumpswap";
  side: "buy" | "sell";
  trader: string | null;
  tokenAmountRaw: bigint;
  tokenAmountUi: number;
  quoteMint: string;
  quoteDecimals: number;
  quoteAmountRaw: bigint | null;
  priceQuotePerToken: number | null;
};

export type SolardTokenCreateEvent = {
  id: string;
  type: "create";
  mint: string;
  signature: string;
  slot: number;
  observedAtMs: number;
  blockTimeMs: number | null;
  confidence: SolardTokenEventConfidence;
  name: string | null;
  symbol: string | null;
  creator: string | null;
  quoteMint: string;
};

export type SolardTokenTransferMovement =
  "transfer" | "mint" | "burn" | "change-owner";

export type SolardTokenTransferSource =
  "live-rpc" | "rpc-history" | "solscan-token-index";

export type SolardTokenTransferEvent = {
  id: string;
  type: "transfer";
  mint: string;
  signature: string;
  slot: number;
  observedAtMs: number;
  blockTimeMs: number | null;
  confidence: SolardTokenEventConfidence;
  movement: SolardTokenTransferMovement;
  source: SolardTokenTransferSource;
  sourceTokenAccount: string | null;
  destinationTokenAccount: string | null;
  sourceOwner: string | null;
  destinationOwner: string | null;
  authority: string | null;
  amountRaw: bigint;
  feeRaw: bigint;
  decimals: number;
  instructionType: string;
  transactionIndex: number | null;
  instructionIndex: number | null;
  innerInstructionIndex: number | null;
};

export type SolardTokenEvent =
  SolardTokenSwapEvent | SolardTokenTransferEvent | SolardTokenCreateEvent;

export type SubscribeTokenEventsOptions = {
  swaps?: boolean;
  transfers?: boolean;
  creates?: boolean;
  commitment?: Extract<Commitment, "confirmed" | "finalized">;
  signal?: AbortSignal;
  /** Retry parsed-transaction enrichment because websocket logs can precede RPC indexing. */
  enrichmentAttempts?: number;
  enrichmentDelayMs?: number;
};

export type TokenEventSubscription = AsyncIterable<SolardTokenEvent> & {
  readonly mint: string;
  readonly addresses: string[];
  readonly transferCoverage: "mint-mentioned-transfers";
  close(): Promise<void>;
};

type QueueWaiter<T> = {
  resolve: (value: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
};

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: QueueWaiter<T>[] = [];
  private ended = false;
  private failure: unknown = null;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.failure = error;
    this.end();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      if (this.failure != null) waiter.reject(this.failure);
      else waiter.resolve({ done: true, value: undefined as never });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.ended) {
          if (this.failure != null) throw this.failure;
          return { done: true, value: undefined as never };
        }
        return await new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

function accountKeys(tx: ParsedTransactionWithMeta): string[] {
  return tx.transaction.message.accountKeys.map((row) => row.pubkey.toBase58());
}

type TokenAccountBalance = {
  preOwner: string | null;
  postOwner: string | null;
  preRaw: bigint;
  postRaw: bigint;
};

function tokenAccountBalances(
  tx: ParsedTransactionWithMeta,
  mint: string,
): Map<string, TokenAccountBalance> {
  const keys = accountKeys(tx);
  const out = new Map<string, TokenAccountBalance>();
  for (const row of tx.meta?.preTokenBalances ?? []) {
    if (row.mint !== mint) continue;
    const address = keys[row.accountIndex];
    if (!address) continue;
    const current = out.get(address) ?? {
      preOwner: null,
      postOwner: null,
      preRaw: 0n,
      postRaw: 0n,
    };
    current.preOwner = typeof row.owner === "string" ? row.owner : null;
    current.preRaw = BigInt(row.uiTokenAmount.amount);
    out.set(address, current);
  }
  for (const row of tx.meta?.postTokenBalances ?? []) {
    if (row.mint !== mint) continue;
    const address = keys[row.accountIndex];
    if (!address) continue;
    const current = out.get(address) ?? {
      preOwner: null,
      postOwner: null,
      preRaw: 0n,
      postRaw: 0n,
    };
    current.postOwner = typeof row.owner === "string" ? row.owner : null;
    current.postRaw = BigInt(row.uiTokenAmount.amount);
    out.set(address, current);
  }
  return out;
}

function parsedInstructionRows(tx: ParsedTransactionWithMeta): Array<{
  instruction: ParsedInstruction;
  ordinal: string;
}> {
  const rows: Array<{ instruction: ParsedInstruction; ordinal: string }> = [];
  const add = (
    instruction: ParsedInstruction | PartiallyDecodedInstruction,
    ordinal: string,
  ) => {
    if ("parsed" in instruction) rows.push({ instruction, ordinal });
  };
  tx.transaction.message.instructions.forEach((ix, index) =>
    add(ix, `${index}`),
  );
  for (const inner of tx.meta?.innerInstructions ?? []) {
    inner.instructions.forEach((ix, index) =>
      add(ix, `${inner.index}.${index}`),
    );
  }
  return rows;
}

function ordinalParts(ordinal: string): {
  instructionIndex: number | null;
  innerInstructionIndex: number | null;
} {
  const [top, inner] = ordinal.split(".");
  const instructionIndex = Number(top);
  const innerInstructionIndex = inner == null ? null : Number(inner);
  return {
    instructionIndex: Number.isInteger(instructionIndex)
      ? instructionIndex
      : null,
    innerInstructionIndex:
      innerInstructionIndex != null && Number.isInteger(innerInstructionIndex)
        ? innerInstructionIndex
        : null,
  };
}

function rawAmount(info: Record<string, unknown>): bigint | null {
  const tokenAmount =
    info.tokenAmount && typeof info.tokenAmount === "object"
      ? (info.tokenAmount as Record<string, unknown>)
      : null;
  const raw = tokenAmount?.amount ?? info.amount;
  return typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw) : null;
}

function rawFee(info: Record<string, unknown>): bigint {
  const parse = (value: unknown): bigint | null => {
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      return BigInt(value);
    return null;
  };
  const direct = parse(info.feeAmount);
  if (direct != null) return direct;
  if (info.feeAmount && typeof info.feeAmount === "object") {
    const nested = parse((info.feeAmount as Record<string, unknown>).amount);
    if (nested != null) return nested;
  }
  return 0n;
}

export function parseTokenTransferEvents(args: {
  tx: ParsedTransactionWithMeta;
  signature: string;
  mint: string;
  decimals: number;
  confidence: SolardTokenEventConfidence;
  source?: SolardTokenTransferSource;
}): SolardTokenTransferEvent[] {
  if (!args.tx.meta || args.tx.meta.err) return [];
  const balances = tokenAccountBalances(args.tx, args.mint);
  const output: SolardTokenTransferEvent[] = [];
  const tokenPrograms = new Set([
    SPL_TOKEN_PROGRAM_ID.toBase58(),
    TOKEN_2022_ID.toBase58(),
  ]);
  const source = args.source ?? "live-rpc";

  for (const { instruction, ordinal } of parsedInstructionRows(args.tx)) {
    if (!tokenPrograms.has(instruction.programId.toBase58())) continue;
    const parsed = instruction.parsed as
      { type?: unknown; info?: Record<string, unknown> } | undefined;
    const instructionType = String(parsed?.type ?? "");
    const info = parsed?.info ?? {};
    const directMint = typeof info.mint === "string" ? info.mint : null;
    const order = ordinalParts(ordinal);
    const authority =
      typeof info.authority === "string"
        ? info.authority
        : typeof info.owner === "string"
          ? info.owner
          : null;

    if (/^transfer(?:Checked|CheckedWithFee)?$/i.test(instructionType)) {
      const sourceTokenAccount =
        typeof info.source === "string" ? info.source : null;
      const destinationTokenAccount =
        typeof info.destination === "string" ? info.destination : null;
      if (!sourceTokenAccount || !destinationTokenAccount) continue;
      const inferredMint =
        directMint ??
        (balances.has(sourceTokenAccount) ||
        balances.has(destinationTokenAccount)
          ? args.mint
          : null);
      if (inferredMint !== args.mint) continue;
      const amountRaw = rawAmount(info);
      if (amountRaw == null || amountRaw <= 0n) continue;
      const sourceBalance = balances.get(sourceTokenAccount);
      const destinationBalance = balances.get(destinationTokenAccount);
      const tokenAmount =
        info.tokenAmount && typeof info.tokenAmount === "object"
          ? (info.tokenAmount as Record<string, unknown>)
          : null;
      output.push({
        id: `${args.signature}:transfer:${ordinal}`,
        type: "transfer",
        mint: args.mint,
        signature: args.signature,
        slot: args.tx.slot,
        observedAtMs: Date.now(),
        blockTimeMs:
          args.tx.blockTime == null ? null : args.tx.blockTime * 1_000,
        confidence: args.confidence,
        movement: "transfer",
        source,
        sourceTokenAccount,
        destinationTokenAccount,
        sourceOwner:
          sourceBalance?.preOwner ?? sourceBalance?.postOwner ?? null,
        destinationOwner:
          destinationBalance?.postOwner ?? destinationBalance?.preOwner ?? null,
        authority,
        amountRaw,
        feeRaw: rawFee(info),
        decimals:
          typeof tokenAmount?.decimals === "number"
            ? tokenAmount.decimals
            : args.decimals,
        instructionType,
        transactionIndex: null,
        ...order,
      });
      continue;
    }

    if (/^mintTo(?:Checked)?$/i.test(instructionType)) {
      const destinationTokenAccount =
        typeof info.account === "string"
          ? info.account
          : typeof info.destination === "string"
            ? info.destination
            : null;
      if (!destinationTokenAccount || directMint !== args.mint) continue;
      const amountRaw = rawAmount(info);
      if (amountRaw == null || amountRaw <= 0n) continue;
      const destinationBalance = balances.get(destinationTokenAccount);
      output.push({
        id: `${args.signature}:mint:${ordinal}`,
        type: "transfer",
        mint: args.mint,
        signature: args.signature,
        slot: args.tx.slot,
        observedAtMs: Date.now(),
        blockTimeMs:
          args.tx.blockTime == null ? null : args.tx.blockTime * 1_000,
        confidence: args.confidence,
        movement: "mint",
        source,
        sourceTokenAccount: null,
        destinationTokenAccount,
        sourceOwner: null,
        destinationOwner:
          destinationBalance?.postOwner ?? destinationBalance?.preOwner ?? null,
        authority,
        amountRaw,
        feeRaw: 0n,
        decimals: args.decimals,
        instructionType,
        transactionIndex: null,
        ...order,
      });
      continue;
    }

    if (/^burn(?:Checked)?$/i.test(instructionType)) {
      const sourceTokenAccount =
        typeof info.account === "string"
          ? info.account
          : typeof info.source === "string"
            ? info.source
            : null;
      if (!sourceTokenAccount || directMint !== args.mint) continue;
      const amountRaw = rawAmount(info);
      if (amountRaw == null || amountRaw <= 0n) continue;
      const sourceBalance = balances.get(sourceTokenAccount);
      output.push({
        id: `${args.signature}:burn:${ordinal}`,
        type: "transfer",
        mint: args.mint,
        signature: args.signature,
        slot: args.tx.slot,
        observedAtMs: Date.now(),
        blockTimeMs:
          args.tx.blockTime == null ? null : args.tx.blockTime * 1_000,
        confidence: args.confidence,
        movement: "burn",
        source,
        sourceTokenAccount,
        destinationTokenAccount: null,
        sourceOwner:
          sourceBalance?.preOwner ?? sourceBalance?.postOwner ?? null,
        destinationOwner: null,
        authority,
        amountRaw,
        feeRaw: 0n,
        decimals: args.decimals,
        instructionType,
        transactionIndex: null,
        ...order,
      });
      continue;
    }

    if (/^setAuthority$/i.test(instructionType)) {
      const account = typeof info.account === "string" ? info.account : null;
      const authorityType = String(info.authorityType ?? "").toLowerCase();
      if (!account || !authorityType.includes("owner")) continue;
      const balance = balances.get(account);
      if (!balance || balance.preOwner === balance.postOwner) continue;
      const amountRaw = balance.postRaw || balance.preRaw;
      if (amountRaw <= 0n) continue;
      output.push({
        id: `${args.signature}:change-owner:${ordinal}`,
        type: "transfer",
        mint: args.mint,
        signature: args.signature,
        slot: args.tx.slot,
        observedAtMs: Date.now(),
        blockTimeMs:
          args.tx.blockTime == null ? null : args.tx.blockTime * 1_000,
        confidence: args.confidence,
        movement: "change-owner",
        source,
        sourceTokenAccount: account,
        destinationTokenAccount: account,
        sourceOwner: balance.preOwner,
        destinationOwner: balance.postOwner,
        authority,
        amountRaw,
        feeRaw: 0n,
        decimals: args.decimals,
        instructionType,
        transactionIndex: null,
        ...order,
      });
    }
  }
  return output;
}

function ownerMintDelta(
  tx: ParsedTransactionWithMeta,
  owner: string,
  mint: string,
): bigint | null {
  let pre = 0n;
  let post = 0n;
  let seen = false;
  for (const row of tx.meta?.preTokenBalances ?? []) {
    if (row.owner !== owner || row.mint !== mint) continue;
    pre += BigInt(row.uiTokenAmount.amount);
    seen = true;
  }
  for (const row of tx.meta?.postTokenBalances ?? []) {
    if (row.owner !== owner || row.mint !== mint) continue;
    post += BigInt(row.uiTokenAmount.amount);
    seen = true;
  }
  return seen ? post - pre : null;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function createEvents(args: {
  tx: ParsedTransactionWithMeta;
  signature: string;
  token: TokenRow;
  confidence: SolardTokenEventConfidence;
}): SolardTokenCreateEvent[] {
  const marker = findPumpHistoryCreateMarker(
    args.tx,
    args.signature,
    args.token.mint,
  );
  if (!marker) return [];
  return [
    {
      id: `${args.signature}:create`,
      type: "create",
      mint: args.token.mint,
      signature: args.signature,
      slot: marker.slot,
      observedAtMs: Date.now(),
      blockTimeMs: marker.atMs,
      confidence: args.confidence,
      name: marker.name,
      symbol: marker.symbol,
      creator: args.token.creator,
      quoteMint: args.token.quoteMint ?? NATIVE_MINT.toBase58(),
    },
  ];
}

function swapEvents(args: {
  tx: ParsedTransactionWithMeta;
  signature: string;
  token: TokenRow;
  decimals: number;
  quoteDecimals: number;
  supplyUi: number;
  confidence: SolardTokenEventConfidence;
}): SolardTokenSwapEvent[] {
  const parsed = parsePumpHistoryTransaction({
    tx: args.tx,
    signature: args.signature,
    mint: args.token.mint,
    decimals: args.decimals,
    supplyUi: args.supplyUi,
    historyOrder: 0,
    scanAddress: args.token.bondingCurve ?? args.token.pool ?? args.token.mint,
    scanKind: args.token.venueHint === "pumpswap" ? "pool" : "curve",
    confidence: args.confidence,
  });
  const quoteMint = args.token.quoteMint ?? NATIVE_MINT.toBase58();
  const nativePair = quoteMint === NATIVE_MINT.toBase58();
  return parsed.trades.map((trade, index) => {
    const tokenAmountRaw = BigInt(
      trade.history.ownerTokenDeltaRaw.replace("-", ""),
    );
    const customQuoteDelta =
      !nativePair && trade.owner
        ? ownerMintDelta(args.tx, trade.owner, quoteMint)
        : null;
    const quoteAmountRaw = nativePair
      ? trade.history.economicQuoteDeltaLamports != null
        ? BigInt(trade.history.economicQuoteDeltaLamports.replace("-", ""))
        : null
      : customQuoteDelta == null
        ? null
        : absolute(customQuoteDelta);
    const tokenUi = Number(tokenAmountRaw) / 10 ** args.decimals;
    const quoteUi =
      quoteAmountRaw == null
        ? null
        : Number(quoteAmountRaw) / 10 ** args.quoteDecimals;
    return {
      id: `${trade.eventKey}:live:${index}`,
      type: "swap",
      mint: trade.mint,
      signature: trade.signature,
      slot: trade.slot,
      observedAtMs: Date.now(),
      blockTimeMs: trade.tradedAtMs,
      confidence: args.confidence,
      venue: trade.history.venue,
      side: trade.side,
      trader: trade.owner,
      tokenAmountRaw,
      tokenAmountUi: trade.tokenDeltaUi,
      quoteMint,
      quoteDecimals: args.quoteDecimals,
      quoteAmountRaw,
      priceQuotePerToken:
        quoteUi != null && tokenUi > 0 ? quoteUi / tokenUi : null,
    };
  });
}

async function getParsedTransactionWithRetry(args: {
  connection: Connection;
  signature: string;
  commitment: SolardTokenEventConfidence;
  attempts: number;
  delayMs: number;
}): Promise<ParsedTransactionWithMeta | null> {
  for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
    const tx = await args.connection.getParsedTransaction(args.signature, {
      commitment: args.commitment,
      maxSupportedTransactionVersion: 0,
    });
    if (tx) return tx;
    if (attempt < args.attempts) {
      await new Promise((resolve) =>
        setTimeout(resolve, args.delayMs * attempt),
      );
    }
  }
  return null;
}

/**
 * Typed, per-token websocket event stream for application/backend consumers.
 *
 * Pump swaps are complete for the subscribed known bonding-curve/pool addresses.
 * Generic transfer delivery is intentionally labelled mint-mentioned: standard
 * SPL `transfer` instructions can omit the mint account. Reward calculations
 * must use snapshotTokenHolders(), never infer balances solely from this stream.
 */
export async function subscribeTokenEvents(args: {
  connection: Connection;
  token: TokenRow;
  options?: SubscribeTokenEventsOptions;
}): Promise<TokenEventSubscription> {
  const options = args.options ?? {};
  const swaps = options.swaps ?? true;
  const transfers = options.transfers ?? true;
  const creates = options.creates ?? false;
  if (!swaps && !transfers && !creates)
    throw new Error("Enable swaps, transfers, and/or creates");
  const commitment = options.commitment ?? "confirmed";
  const attempts = Math.max(1, Math.trunc(options.enrichmentAttempts ?? 6));
  const delayMs = Math.max(50, Math.trunc(options.enrichmentDelayMs ?? 250));
  const mint = new PublicKey(args.token.mint);
  const mintInfo = await readMint(args.connection, mint);
  const quoteMint = args.token.quoteMint ?? NATIVE_MINT.toBase58();
  const quoteDecimals =
    quoteMint === NATIVE_MINT.toBase58()
      ? 9
      : (await readMint(args.connection, new PublicKey(quoteMint))).decimals;
  const supplyUi = Number(mintInfo.supply) / 10 ** mintInfo.decimals;

  const queue = new AsyncQueue<SolardTokenEvent>();
  const listenerIds: number[] = [];
  const signatures = new Set<string>();
  const eventIds = new Set<string>();
  let closed = false;

  const addresses = new Set<string>();
  if (swaps) {
    if (args.token.bondingCurve) addresses.add(args.token.bondingCurve);
    if (args.token.pool) addresses.add(args.token.pool);
  }
  if (transfers || creates) addresses.add(mint.toBase58());
  if (!addresses.size) {
    throw new Error(
      `Token ${mint.toBase58()} has no known bonding-curve/pool address to subscribe to`,
    );
  }

  const enqueue = (signature: string) => {
    if (closed || signatures.has(signature)) return;
    signatures.add(signature);
    void (async () => {
      try {
        const tx = await getParsedTransactionWithRetry({
          connection: args.connection,
          signature,
          commitment,
          attempts,
          delayMs,
        });
        if (!tx || tx.meta?.err) return;
        const events: SolardTokenEvent[] = [];
        if (creates) {
          events.push(
            ...createEvents({
              tx,
              signature,
              token: args.token,
              confidence: commitment,
            }),
          );
        }
        if (swaps) {
          events.push(
            ...swapEvents({
              tx,
              signature,
              token: args.token,
              decimals: mintInfo.decimals,
              quoteDecimals,
              supplyUi,
              confidence: commitment,
            }),
          );
        }
        if (transfers) {
          events.push(
            ...parseTokenTransferEvents({
              tx,
              signature,
              mint: mint.toBase58(),
              decimals: mintInfo.decimals,
              confidence: commitment,
            }),
          );
        }
        for (const event of events) {
          if (eventIds.has(event.id)) continue;
          eventIds.add(event.id);
          queue.push(event);
        }
      } catch {
        // Do not kill a long-running event stream because one RPC enrichment
        // attempt exhausted its retries. If the signature is observed again by
        // another watched address it may be retried.
        signatures.delete(signature);
      }
    })();
  };

  for (const address of addresses) {
    const id = args.connection.onLogs(
      new PublicKey(address),
      (logs) => {
        if (!logs.err) enqueue(logs.signature);
      },
      commitment,
    );
    listenerIds.push(id);
  }

  const close = async () => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", abort);
    await Promise.all(
      listenerIds.map((id) => args.connection.removeOnLogsListener(id)),
    );
    queue.end();
  };
  const abort = () => void close();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) await close();

  return {
    mint: mint.toBase58(),
    addresses: [...addresses],
    transferCoverage: "mint-mentioned-transfers",
    close,
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
  };
}
