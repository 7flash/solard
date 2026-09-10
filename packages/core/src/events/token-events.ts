import {
  PublicKey,
  type Commitment,
  type Connection,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";

import { readMint } from "../chain/state.ts";
import { parsePumpHistoryTransaction } from "../chain/token-history/parser.ts";
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
  /** Native-SOL quote amount when the token is SOL-paired; null for custom pairs. */
  quoteAmountRaw: bigint | null;
  priceQuotePerToken: number | null;
};

export type SolardTokenTransferEvent = {
  id: string;
  type: "transfer";
  mint: string;
  signature: string;
  slot: number;
  observedAtMs: number;
  blockTimeMs: number | null;
  confidence: SolardTokenEventConfidence;
  sourceTokenAccount: string;
  destinationTokenAccount: string;
  sourceOwner: string | null;
  destinationOwner: string | null;
  authority: string | null;
  amountRaw: bigint;
  decimals: number;
  instructionType: string;
};

export type SolardTokenEvent = SolardTokenSwapEvent | SolardTokenTransferEvent;

export type SubscribeTokenEventsOptions = {
  swaps?: boolean;
  transfers?: boolean;
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

function ownerByTokenAccount(
  tx: ParsedTransactionWithMeta,
  mint: string,
): Map<string, string | null> {
  const keys = accountKeys(tx);
  const out = new Map<string, string | null>();
  for (const row of [
    ...(tx.meta?.preTokenBalances ?? []),
    ...(tx.meta?.postTokenBalances ?? []),
  ]) {
    if (row.mint !== mint) continue;
    const address = keys[row.accountIndex];
    if (!address) continue;
    out.set(address, typeof row.owner === "string" ? row.owner : null);
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

function transferEvents(args: {
  tx: ParsedTransactionWithMeta;
  signature: string;
  mint: string;
  decimals: number;
  confidence: SolardTokenEventConfidence;
}): SolardTokenTransferEvent[] {
  if (!args.tx.meta || args.tx.meta.err) return [];
  const owners = ownerByTokenAccount(args.tx, args.mint);
  const output: SolardTokenTransferEvent[] = [];
  const tokenPrograms = new Set([
    SPL_TOKEN_PROGRAM_ID.toBase58(),
    TOKEN_2022_ID.toBase58(),
  ]);

  for (const { instruction, ordinal } of parsedInstructionRows(args.tx)) {
    if (!tokenPrograms.has(instruction.programId.toBase58())) continue;
    const parsed = instruction.parsed as
      { type?: unknown; info?: Record<string, unknown> } | undefined;
    const instructionType = String(parsed?.type ?? "");
    if (!/^transfer(?:Checked|CheckedWithFee)?$/i.test(instructionType))
      continue;
    const info = parsed?.info ?? {};
    const sourceTokenAccount =
      typeof info.source === "string" ? info.source : null;
    const destinationTokenAccount =
      typeof info.destination === "string" ? info.destination : null;
    if (!sourceTokenAccount || !destinationTokenAccount) continue;

    const directMint = typeof info.mint === "string" ? info.mint : null;
    const inferredMint =
      directMint ??
      (owners.has(sourceTokenAccount) || owners.has(destinationTokenAccount)
        ? args.mint
        : null);
    if (inferredMint !== args.mint) continue;

    const tokenAmount =
      info.tokenAmount && typeof info.tokenAmount === "object"
        ? (info.tokenAmount as Record<string, unknown>)
        : null;
    const raw = tokenAmount?.amount ?? info.amount;
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) continue;
    const amountRaw = BigInt(raw);
    if (amountRaw <= 0n) continue;
    const decimals =
      typeof tokenAmount?.decimals === "number"
        ? tokenAmount.decimals
        : args.decimals;

    output.push({
      id: `${args.signature}:transfer:${ordinal}`,
      type: "transfer",
      mint: args.mint,
      signature: args.signature,
      slot: args.tx.slot,
      observedAtMs: Date.now(),
      blockTimeMs: args.tx.blockTime == null ? null : args.tx.blockTime * 1_000,
      confidence: args.confidence,
      sourceTokenAccount,
      destinationTokenAccount,
      sourceOwner: owners.get(sourceTokenAccount) ?? null,
      destinationOwner: owners.get(destinationTokenAccount) ?? null,
      authority:
        typeof info.authority === "string"
          ? info.authority
          : typeof info.owner === "string"
            ? info.owner
            : null,
      amountRaw,
      decimals,
      instructionType,
    });
  }
  return output;
}

function swapEvents(args: {
  tx: ParsedTransactionWithMeta;
  signature: string;
  token: TokenRow;
  decimals: number;
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
  const nativePair =
    args.token.quoteMint == null ||
    args.token.quoteMint === "So11111111111111111111111111111111111111112";
  return parsed.trades.map((trade, index) => {
    const tokenAmountRaw = BigInt(
      trade.history.ownerTokenDeltaRaw.replace("-", ""),
    );
    const quoteAmountRaw =
      nativePair && trade.history.economicQuoteDeltaLamports != null
        ? BigInt(trade.history.economicQuoteDeltaLamports.replace("-", ""))
        : null;
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
      quoteAmountRaw,
      priceQuotePerToken: nativePair ? trade.priceSol : null,
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
 * Typed, per-token websocket event stream for Fairfun/backend consumers.
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
  if (!swaps && !transfers) throw new Error("Enable swaps and/or transfers");
  const commitment = options.commitment ?? "confirmed";
  const attempts = Math.max(1, Math.trunc(options.enrichmentAttempts ?? 6));
  const delayMs = Math.max(50, Math.trunc(options.enrichmentDelayMs ?? 250));
  const mint = new PublicKey(args.token.mint);
  const mintInfo = await readMint(args.connection, mint);
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
  if (transfers) addresses.add(mint.toBase58());
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
        if (swaps) {
          events.push(
            ...swapEvents({
              tx,
              signature,
              token: args.token,
              decimals: mintInfo.decimals,
              supplyUi,
              confidence: commitment,
            }),
          );
        }
        if (transfers) {
          events.push(
            ...transferEvents({
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
