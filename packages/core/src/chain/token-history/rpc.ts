import {
  PublicKey,
  type ConfirmedSignatureInfo,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";

import { createSolardMeasure } from "../../core/log.ts";
import { solardRpcFetch } from "../connection.ts";
import { measured } from "../../core/measured.ts";
import { TokenHistoryError, tokenHistoryError } from "./errors.ts";
import type {
  NormalizedTokenHistoryRpcOptions,
  TokenHistoryScanKind,
  TokenHistoryScanResult,
  TokenHistoryScanSignature,
  TokenHistoryTransactionFetchResult,
} from "./types.ts";

const m = createSolardMeasure("history:rpc");
const MIN_SPLIT_BATCH = 5;
const MAX_BACKOFF_MS = 15_000;

type JsonRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

type JsonRpcBatchRow = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: ParsedTransactionWithMeta | null;
  error?: JsonRpcError;
};

type TransactionBatchResult = {
  bySignature: Map<string, ParsedTransactionWithMeta>;
  missingTransactions: number;
  failedTransactions: number;
  rateLimited: boolean;
};

type AddressHistoryFullRow = ParsedTransactionWithMeta & {
  transactionIndex?: number;
};

type AddressHistoryFullResult = {
  data?: AddressHistoryFullRow[];
  paginationToken?: string | null;
};

type AddressHistoryWindow = {
  address: string;
  signatures: Set<string>;
  minSlot: number;
  maxSlot: number;
};

class HistoryUnsupportedMethodError extends Error {
  readonly name = "HistoryUnsupportedMethodError";
}

class HistoryRateLimitError extends Error {
  readonly name = "HistoryRateLimitError";
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

class HistoryHttpError extends Error {
  readonly name = "HistoryHttpError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface TokenHistoryRpc {
  scanAddress(
    kind: TokenHistoryScanKind,
    address: PublicKey,
    options: NormalizedTokenHistoryRpcOptions,
  ): Promise<TokenHistoryScanResult>;
  fetchTransactions(
    signatures: readonly TokenHistoryScanSignature[],
    options: NormalizedTokenHistoryRpcOptions,
  ): Promise<TokenHistoryTransactionFetchResult>;
}

function sleep(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryAfterMs(response: Response, fallbackMs: number): number {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(250, Math.floor(seconds * 1_000));
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(250, at - Date.now()) : fallbackMs;
}

function errorLooksRateLimited(error: unknown): boolean {
  if (error instanceof HistoryRateLimitError) return true;
  return /\b429\b|too many requests|rate.?limit/i.test(messageOf(error));
}

function rpcErrorLooksRateLimited(error: JsonRpcError | undefined): boolean {
  if (!error) return false;
  return (
    error.code === 429 ||
    /\b429\b|too many requests|rate.?limit/i.test(error.message ?? "")
  );
}

function shouldSplitBatch(error: unknown): boolean {
  if (errorLooksRateLimited(error)) return true;
  if (error instanceof HistoryHttpError && error.status === 413) return true;
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "RPC_TIMEOUT"
  );
}

function backoffMs(
  options: NormalizedTokenHistoryRpcOptions,
  attempt: number,
  floorMs = 0,
): number {
  return Math.min(
    MAX_BACKOFF_MS,
    Math.max(floorMs, options.retryDelayMs * 2 ** Math.max(0, attempt - 1)),
  );
}

async function measuredBackoff(args: {
  operation: "signatures" | "transactions";
  waitMs: number;
  reason: string;
}): Promise<void> {
  await measured(
    m,
    "retry backoff",
    async () => {
      await sleep(args.waitMs);
      return args.waitMs;
    },
    (waitMs) => ({
      operation: args.operation,
      waitMs,
      reason: args.reason,
    }),
  );
}

async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new TokenHistoryError(
                "RPC_TIMEOUT",
                `${label} timed out after ${timeoutMs}ms`,
                { stage: "rpc", recoverable: true },
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function retryRpc<T>(args: {
  operation: "signatures";
  kind?: TokenHistoryScanKind;
  options: NormalizedTokenHistoryRpcOptions;
  run: () => Promise<T>;
}): Promise<T> {
  let lastError: unknown;
  const maxAttempts = args.options.rpcRetries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await args.run();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      const waitMs = backoffMs(args.options, attempt);
      args.options.onProgress?.({
        phase: "retry",
        operation: args.operation,
        kind: args.kind,
        attempt,
        maxAttempts,
        error: messageOf(error),
      });
      await measuredBackoff({
        operation: args.operation,
        waitMs,
        reason: errorLooksRateLimited(error) ? "rate-limit" : "rpc-error",
      });
    }
  }
  throw tokenHistoryError(lastError, {
    code: "RPC_FAILED",
    message: `Historical RPC ${args.operation} failed after ${maxAttempts} attempt(s)`,
    stage: args.operation,
    recoverable: true,
    context: { kind: args.kind ?? null, attempts: maxAttempts },
  });
}

function mergeBatchResults(
  left: TransactionBatchResult,
  right: TransactionBatchResult,
): TransactionBatchResult {
  return {
    bySignature: new Map([...left.bySignature, ...right.bySignature]),
    missingTransactions: left.missingTransactions + right.missingTransactions,
    failedTransactions: left.failedTransactions + right.failedTransactions,
    rateLimited: left.rateLimited || right.rateLimited,
  };
}

export class SolanaTokenHistoryRpc implements TokenHistoryRpc {
  private transactionCooldownUntilMs = 0;
  private addressHistoryFastPath: "unknown" | "supported" | "unsupported" =
    "unknown";

  constructor(private readonly connection: Connection) {}

  private async waitForTransactionCooldown(): Promise<void> {
    const waitMs = Math.max(0, this.transactionCooldownUntilMs - Date.now());
    if (waitMs <= 0) return;
    await measuredBackoff({
      operation: "transactions",
      waitMs,
      reason: "shared-cooldown",
    });
  }

  private noteRateLimit(waitMs: number): void {
    this.transactionCooldownUntilMs = Math.max(
      this.transactionCooldownUntilMs,
      Date.now() + waitMs,
    );
  }

  private async transactionHttpBatch(
    batch: readonly TokenHistoryScanSignature[],
    options: NormalizedTokenHistoryRpcOptions,
  ): Promise<TransactionBatchResult> {
    return measured(
      m,
      "transactions http",
      async () => {
        await this.waitForTransactionCooldown();

        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          options.rpcTimeoutMs,
        );
        try {
          const response = await solardRpcFetch(
            this.connection.rpcEndpoint,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(
                batch.map((row, index) => ({
                  jsonrpc: "2.0",
                  id: index + 1,
                  method: "getTransaction",
                  params: [
                    row.signature,
                    {
                      encoding: "jsonParsed",
                      commitment: options.commitment,
                      maxSupportedTransactionVersion: 0,
                    },
                  ],
                })),
              ),
              signal: controller.signal,
            },
            { retry429: false },
          );

          if (response.status === 429) {
            const waitMs = retryAfterMs(response, options.retryDelayMs);
            throw new HistoryRateLimitError(
              `429 Too Many Requests from historical transaction RPC`,
              waitMs,
            );
          }
          if (!response.ok) {
            throw new HistoryHttpError(
              `Historical transaction RPC HTTP ${response.status}: ${response.statusText}`,
              response.status,
            );
          }

          const payload = (await response.json()) as
            JsonRpcBatchRow[] | JsonRpcBatchRow;
          const rows = Array.isArray(payload) ? payload : [payload];
          if (rows.some((row) => rpcErrorLooksRateLimited(row.error))) {
            throw new HistoryRateLimitError(
              `Historical transaction RPC returned a rate-limit error`,
              options.retryDelayMs,
            );
          }

          const byId = new Map<number, JsonRpcBatchRow>();
          for (const row of rows) {
            const id = Number(row.id);
            if (Number.isInteger(id) && id > 0) byId.set(id, row);
          }

          const bySignature = new Map<string, ParsedTransactionWithMeta>();
          let missingTransactions = 0;
          let failedTransactions = 0;
          for (let index = 0; index < batch.length; index += 1) {
            const request = batch[index]!;
            const responseRow = byId.get(index + 1);
            if (!responseRow) {
              failedTransactions += 1;
              continue;
            }
            if (responseRow.error) {
              failedTransactions += 1;
              continue;
            }
            if (!responseRow.result) {
              missingTransactions += 1;
              continue;
            }
            bySignature.set(request.signature, responseRow.result);
          }

          return {
            bySignature,
            missingTransactions,
            failedTransactions,
            rateLimited: false,
          };
        } catch (error) {
          if ((error as { name?: unknown })?.name === "AbortError") {
            throw new TokenHistoryError(
              "RPC_TIMEOUT",
              `getTransaction batch timed out after ${options.rpcTimeoutMs}ms`,
              {
                stage: "transactions",
                recoverable: true,
                context: { batchSize: batch.length },
                cause: error,
              },
            );
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }
      },
      (result) => ({
        requested: batch.length,
        returned: result.bySignature.size,
        missing: result.missingTransactions,
        failed: result.failedTransactions,
      }),
    );
  }

  private async fetchAdaptiveTransactionBatch(
    batch: readonly TokenHistoryScanSignature[],
    options: NormalizedTokenHistoryRpcOptions,
  ): Promise<TransactionBatchResult> {
    let lastError: unknown;
    let sawRateLimit = false;
    const maxAttempts = options.rpcRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await this.transactionHttpBatch(batch, options);
        return { ...result, rateLimited: result.rateLimited || sawRateLimit };
      } catch (error) {
        lastError = error;
        const rateLimited = errorLooksRateLimited(error);
        sawRateLimit ||= rateLimited;
        const floorMs =
          error instanceof HistoryRateLimitError ? error.retryAfterMs : 0;
        const waitMs = backoffMs(options, attempt, floorMs);

        if (rateLimited) this.noteRateLimit(waitMs);

        if (shouldSplitBatch(error) && batch.length > MIN_SPLIT_BATCH) {
          const nextSize = Math.ceil(batch.length / 2);
          options.onProgress?.({
            phase: "throttle",
            operation: "transactions",
            reason: rateLimited ? "rate-limit" : "batch-pressure",
            waitMs,
            batchSize: batch.length,
            nextBatchSize: nextSize,
          });
          await measuredBackoff({
            operation: "transactions",
            waitMs,
            reason: rateLimited ? "rate-limit" : "batch-pressure",
          });
          const splitAt = Math.ceil(batch.length / 2);
          const left = await this.fetchAdaptiveTransactionBatch(
            batch.slice(0, splitAt),
            options,
          );
          const right = await this.fetchAdaptiveTransactionBatch(
            batch.slice(splitAt),
            options,
          );
          const merged = mergeBatchResults(left, right);
          return { ...merged, rateLimited: true };
        }

        if (attempt >= maxAttempts) break;
        options.onProgress?.({
          phase: "retry",
          operation: "transactions",
          attempt,
          maxAttempts,
          error: messageOf(error),
        });
        await measuredBackoff({
          operation: "transactions",
          waitMs,
          reason: rateLimited ? "rate-limit" : "rpc-error",
        });
      }
    }

    throw tokenHistoryError(lastError, {
      code: "RPC_FAILED",
      message: `Historical RPC transactions failed after ${maxAttempts} attempt(s)`,
      stage: "transactions",
      recoverable: true,
      context: { attempts: maxAttempts, batchSize: batch.length },
    });
  }

  async scanAddress(
    kind: TokenHistoryScanKind,
    address: PublicKey,
    options: NormalizedTokenHistoryRpcOptions,
  ): Promise<TokenHistoryScanResult> {
    return measured(
      m,
      "scan address",
      async () => {
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

          let page: ConfirmedSignatureInfo[];
          try {
            page = await retryRpc({
              operation: "signatures",
              kind,
              options,
              run: () =>
                measured(
                  m,
                  "signatures page",
                  () =>
                    withTimeout(
                      () =>
                        this.connection.getSignaturesForAddress(
                          address,
                          { limit, ...(before ? { before } : {}) },
                          options.commitment,
                        ),
                      options.rpcTimeoutMs,
                      `getSignaturesForAddress ${kind}`,
                    ),
                  (result) => ({
                    kind,
                    requested: limit,
                    fetched: result.length,
                    paginated: before != null,
                  }),
                ),
            });
          } catch (error) {
            options.onProgress?.({
              phase: "rpc-error",
              operation: "signatures",
              kind,
              error: messageOf(error),
              failedItems: limit,
            });
            throw error;
          }

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

        const chronological: TokenHistoryScanSignature[] = [...rows]
          .reverse()
          .map((row, index) => ({
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
      },
      (result) => ({
        kind,
        pages: result.coverage.pages,
        signatures: result.coverage.signatures,
        reachedStart: result.coverage.reachedStart,
        truncated: result.coverage.truncated,
      }),
    );
  }

  private transactionSignature(tx: ParsedTransactionWithMeta): string | null {
    const signature = (tx.transaction as any)?.signatures?.[0];
    return typeof signature === "string" && signature ? signature : null;
  }

  private addressHistoryWindows(
    signatures: readonly TokenHistoryScanSignature[],
  ): AddressHistoryWindow[] {
    const byAddress = new Map<string, TokenHistoryScanSignature[]>();
    for (const row of signatures) {
      const rows = byAddress.get(row.scanAddress) ?? [];
      rows.push(row);
      byAddress.set(row.scanAddress, rows);
    }

    // Keep each full-history cursor reasonably small so --rpc-concurrency can
    // parallelize a very hot address. Windows intentionally overlap one slot at
    // boundaries; results are deduplicated by signature, which avoids dropping
    // transactions when many entries share the same slot.
    const targetPerWindow = 5_000;
    const windows: AddressHistoryWindow[] = [];
    for (const [address, rawRows] of byAddress) {
      const rows = [...rawRows].sort(
        (left, right) =>
          left.slot - right.slot ||
          left.localChronologicalOrder - right.localChronologicalOrder,
      );
      let start = 0;
      while (start < rows.length) {
        let end = Math.min(rows.length, start + targetPerWindow);
        if (end < rows.length) {
          const boundarySlot = rows[end - 1]!.slot;
          while (end < rows.length && rows[end]!.slot === boundarySlot)
            end += 1;
        }
        const slice = rows.slice(start, end);
        windows.push({
          address,
          signatures: new Set(slice.map((row) => row.signature)),
          minSlot: slice[0]!.slot,
          maxSlot: slice.at(-1)!.slot,
        });
        start = end;
      }
    }
    return windows;
  }

  private async addressHistoryFullPage(args: {
    window: AddressHistoryWindow;
    paginationToken?: string | null;
    options: NormalizedTokenHistoryRpcOptions;
  }): Promise<AddressHistoryFullResult> {
    const { window, paginationToken, options } = args;
    return await measured(
      m,
      "transactions address page",
      async () => {
        await this.waitForTransactionCooldown();
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          options.rpcTimeoutMs,
        );
        try {
          const response = await solardRpcFetch(
            this.connection.rpcEndpoint,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "getTransactionsForAddress",
                params: [
                  window.address,
                  {
                    transactionDetails: "full",
                    sortOrder: "asc",
                    commitment: options.commitment,
                    // Helius currently caps full transaction pages at 100.
                    limit: 100,
                    encoding: "jsonParsed",
                    maxSupportedTransactionVersion: 0,
                    filters: {
                      status: "succeeded",
                      slot: { gte: window.minSlot, lte: window.maxSlot },
                    },
                    ...(paginationToken ? { paginationToken } : {}),
                  },
                ],
              }),
              signal: controller.signal,
            },
            { retry429: false },
          );

          if (response.status === 429) {
            const waitMs = retryAfterMs(response, options.retryDelayMs);
            throw new HistoryRateLimitError(
              "429 Too Many Requests from getTransactionsForAddress",
              waitMs,
            );
          }

          const payload = (await response.json().catch(() => null)) as {
            result?: AddressHistoryFullResult | null;
            error?: JsonRpcError;
          } | null;
          const rpcError = payload?.error;
          const unsupportedMessage = rpcError?.message ?? "";
          if (
            rpcError?.code === -32601 ||
            /method not found|unsupported|not available|not enabled|upgrade.*plan/i.test(
              unsupportedMessage,
            )
          ) {
            throw new HistoryUnsupportedMethodError(
              unsupportedMessage || "getTransactionsForAddress is unsupported",
            );
          }
          if (!response.ok) {
            // Some providers reject unknown/private RPC methods at the HTTP
            // layer instead of returning JSON-RPC -32601. Treat 400/403/404 as
            // an unavailable fast path and preserve the standard fallback.
            if ([400, 403, 404].includes(response.status)) {
              throw new HistoryUnsupportedMethodError(
                `getTransactionsForAddress unavailable (HTTP ${response.status})`,
              );
            }
            throw new HistoryHttpError(
              `getTransactionsForAddress HTTP ${response.status}: ${response.statusText}`,
              response.status,
            );
          }

          if (rpcError) {
            if (
              rpcError.code === -32601 ||
              /method not found|unsupported/i.test(rpcError.message ?? "")
            ) {
              throw new HistoryUnsupportedMethodError(
                rpcError.message ?? "getTransactionsForAddress is unsupported",
              );
            }
            if (rpcErrorLooksRateLimited(rpcError)) {
              throw new HistoryRateLimitError(
                rpcError.message ?? "getTransactionsForAddress rate limited",
                options.retryDelayMs,
              );
            }
            throw new Error(
              `getTransactionsForAddress RPC ${rpcError.code ?? "error"}: ${rpcError.message ?? "unknown error"}`,
            );
          }
          return payload?.result ?? {};
        } catch (error) {
          if ((error as { name?: unknown })?.name === "AbortError") {
            throw new TokenHistoryError(
              "RPC_TIMEOUT",
              `getTransactionsForAddress timed out after ${options.rpcTimeoutMs}ms`,
              {
                stage: "transactions",
                recoverable: true,
                context: {
                  address: window.address,
                  minSlot: window.minSlot,
                  maxSlot: window.maxSlot,
                },
                cause: error,
              },
            );
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }
      },
      (result) => ({
        address: window.address.slice(0, 8),
        requested: window.signatures.size,
        returned: result.data?.length ?? 0,
        paginated: paginationToken != null,
      }),
    );
  }

  private async fetchAddressHistoryWindow(
    window: AddressHistoryWindow,
    options: NormalizedTokenHistoryRpcOptions,
  ): Promise<Map<string, ParsedTransactionWithMeta>> {
    const found = new Map<string, ParsedTransactionWithMeta>();
    let paginationToken: string | null | undefined;
    do {
      let result: AddressHistoryFullResult | null = null;
      let lastError: unknown;
      const maxAttempts = options.rpcRetries + 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          result = await this.addressHistoryFullPage({
            window,
            paginationToken,
            options,
          });
          break;
        } catch (error) {
          if (error instanceof HistoryUnsupportedMethodError) throw error;
          lastError = error;
          const rateLimited = errorLooksRateLimited(error);
          const floorMs =
            error instanceof HistoryRateLimitError ? error.retryAfterMs : 0;
          const waitMs = backoffMs(options, attempt, floorMs);
          if (rateLimited) this.noteRateLimit(waitMs);
          if (attempt >= maxAttempts) break;
          options.onProgress?.({
            phase: "retry",
            operation: "transactions",
            attempt,
            maxAttempts,
            error: messageOf(error),
          });
          await measuredBackoff({
            operation: "transactions",
            waitMs,
            reason: rateLimited ? "rate-limit" : "rpc-error",
          });
        }
      }
      if (!result) {
        throw tokenHistoryError(lastError, {
          code: "RPC_FAILED",
          message: `getTransactionsForAddress failed after ${maxAttempts} attempt(s)`,
          stage: "transactions",
          recoverable: true,
          context: {
            address: window.address,
            minSlot: window.minSlot,
            maxSlot: window.maxSlot,
          },
        });
      }

      for (const tx of result.data ?? []) {
        const signature = this.transactionSignature(tx);
        if (signature && window.signatures.has(signature))
          found.set(signature, tx);
      }
      paginationToken = result.paginationToken;
      if (!result.data?.length) break;
      if (found.size >= window.signatures.size) break;
    } while (paginationToken);

    return found;
  }

  private async fetchTransactionsViaAddressHistory(
    signatures: readonly TokenHistoryScanSignature[],
    options: NormalizedTokenHistoryRpcOptions,
  ): Promise<TokenHistoryTransactionFetchResult | null> {
    if (
      this.addressHistoryFastPath === "unsupported" ||
      signatures.length === 0
    )
      return null;

    const windows = this.addressHistoryWindows(signatures);
    const bySignature = new Map<string, ParsedTransactionWithMeta>();
    let nextWindow = 0;
    let completed = 0;
    let unsupported = false;
    let fatal: unknown = null;

    const worker = async (): Promise<void> => {
      while (!unsupported && !fatal) {
        const index = nextWindow++;
        const window = windows[index];
        if (!window) return;
        try {
          const found = await this.fetchAddressHistoryWindow(window, options);
          for (const [signature, tx] of found) bySignature.set(signature, tx);
          completed += found.size;
          options.onProgress?.({
            phase: "transactions",
            completed: Math.min(completed, signatures.length),
            total: signatures.length,
            batchSize: window.signatures.size,
          });
        } catch (error) {
          if (error instanceof HistoryUnsupportedMethodError) {
            unsupported = true;
            return;
          }
          fatal = error;
          return;
        }
      }
    };

    await Promise.all(
      Array.from(
        {
          length: Math.min(
            options.transactionConcurrency,
            Math.max(1, windows.length),
          ),
        },
        () => worker(),
      ),
    );

    if (unsupported) {
      this.addressHistoryFastPath = "unsupported";
      return null;
    }
    if (fatal) throw fatal;
    this.addressHistoryFastPath = "supported";

    let missingTransactions = 0;
    for (const row of signatures) {
      if (!bySignature.has(row.signature)) missingTransactions += 1;
    }
    return { bySignature, missingTransactions, failedTransactions: 0 };
  }

  async fetchTransactions(
    signatures: readonly TokenHistoryScanSignature[],
    options: NormalizedTokenHistoryRpcOptions,
  ): Promise<TokenHistoryTransactionFetchResult> {
    return measured(
      m,
      "transactions pipeline",
      async () => {
        const fast = await this.fetchTransactionsViaAddressHistory(
          signatures,
          options,
        );
        const bySignature = new Map<string, ParsedTransactionWithMeta>(
          fast?.bySignature ?? [],
        );
        const remaining = fast
          ? signatures.filter((row) => !bySignature.has(row.signature))
          : [...signatures];
        if (remaining.length === 0) {
          return { bySignature, missingTransactions: 0, failedTransactions: 0 };
        }

        // The fast address-history path is best-effort. Any rows it did not
        // return are repaired through the generic batched getTransaction path,
        // so provider quirks or archival gaps cannot silently lose history.
        let missingTransactions = 0;
        let failedTransactions = 0;
        let completed = signatures.length - remaining.length;
        let serializeAfterRateLimit = false;

        const batches: TokenHistoryScanSignature[][] = [];
        for (
          let offset = 0;
          offset < remaining.length;
          offset += options.transactionBatchSize
        ) {
          batches.push(
            remaining.slice(offset, offset + options.transactionBatchSize),
          );
        }

        let nextBatch = 0;
        const worker = async (workerIndex: number): Promise<void> => {
          while (true) {
            if (serializeAfterRateLimit && workerIndex > 0) return;
            const batchIndex = nextBatch++;
            const batch = batches[batchIndex];
            if (!batch) return;

            try {
              const result = await this.fetchAdaptiveTransactionBatch(
                batch,
                options,
              );
              if (result.rateLimited) serializeAfterRateLimit = true;
              for (const [signature, tx] of result.bySignature) {
                bySignature.set(signature, tx);
              }
              missingTransactions += result.missingTransactions;
              failedTransactions += result.failedTransactions;
            } catch (error) {
              failedTransactions += batch.length;
              options.onProgress?.({
                phase: "rpc-error",
                operation: "transactions",
                error: messageOf(error),
                failedItems: batch.length,
              });
            }

            completed += batch.length;
            options.onProgress?.({
              phase: "transactions",
              completed: Math.min(completed, signatures.length),
              total: signatures.length,
              batchSize: batch.length,
            });
          }
        };

        const workers = Array.from(
          {
            length: Math.min(
              options.transactionConcurrency,
              Math.max(1, batches.length),
            ),
          },
          (_, workerIndex) => worker(workerIndex),
        );
        await Promise.all(workers);

        // If a rate limit caused secondary workers to stop after claiming work,
        // worker 0 may have exited before all queued batches were consumed.
        while (nextBatch < batches.length) {
          const batch = batches[nextBatch++]!;
          try {
            const result = await this.fetchAdaptiveTransactionBatch(
              batch,
              options,
            );
            for (const [signature, tx] of result.bySignature) {
              bySignature.set(signature, tx);
            }
            missingTransactions += result.missingTransactions;
            failedTransactions += result.failedTransactions;
          } catch (error) {
            failedTransactions += batch.length;
            options.onProgress?.({
              phase: "rpc-error",
              operation: "transactions",
              error: messageOf(error),
              failedItems: batch.length,
            });
          }
          completed += batch.length;
          options.onProgress?.({
            phase: "transactions",
            completed: Math.min(completed, signatures.length),
            total: signatures.length,
            batchSize: batch.length,
          });
        }

        return { bySignature, missingTransactions, failedTransactions };
      },
      (result) => ({
        requested: signatures.length,
        returned: result.bySignature.size,
        missing: result.missingTransactions,
        failed: result.failedTransactions,
        batchSize: options.transactionBatchSize,
        concurrency: options.transactionConcurrency,
      }),
    );
  }
}

export function mergeTokenHistorySignatures(
  curve: readonly TokenHistoryScanSignature[],
  pool: readonly TokenHistoryScanSignature[],
): TokenHistoryScanSignature[] {
  const unique = new Map<string, TokenHistoryScanSignature>();
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

// Compatibility wrappers for callers that still pass Connection directly.
export async function scanTokenHistoryAddress(
  connection: Connection,
  kind: TokenHistoryScanKind,
  address: PublicKey,
  options: NormalizedTokenHistoryRpcOptions,
): Promise<TokenHistoryScanResult> {
  return new SolanaTokenHistoryRpc(connection).scanAddress(
    kind,
    address,
    options,
  );
}

export async function fetchTokenHistoryTransactions(
  connection: Connection,
  signatures: readonly TokenHistoryScanSignature[],
  options: NormalizedTokenHistoryRpcOptions,
): Promise<TokenHistoryTransactionFetchResult> {
  return new SolanaTokenHistoryRpc(connection).fetchTransactions(
    signatures,
    options,
  );
}

export type TokenHistoryRpcOptions = NormalizedTokenHistoryRpcOptions;
