import { NATIVE_MINT } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import { measure } from "../../core/log.ts";
import { measured, measuredSync } from "../../core/measured.ts";
import { TokenHistoryError } from "./errors.ts";
import { buildSparseTokenHistoryCandles1s } from "./candles.ts";
import {
  findPumpHistoryCreateMarker,
  parsePumpHistoryTransaction,
} from "./parser.ts";
import type { TokenHistoryRepository } from "./repository.ts";
import { mergeTokenHistorySignatures, type TokenHistoryRpc } from "./rpc.ts";
import type {
  BackfillTokenHistoryOptions,
  NormalizedTokenHistoryRpcOptions,
  TokenHistoryClock,
  TokenHistoryCoverage,
  TokenHistoryTrade,
} from "./types.ts";

const m = measure("history");

export type TokenHistoryMintInfo = {
  decimals: number;
  supply: bigint;
};

export type TokenHistoryInspection = {
  bondingCurve: string | null;
  pool: string | null;
  quoteMint: string | null;
};

export type TokenHistoryBackfillDependencies = {
  clock: TokenHistoryClock;
  rpc: TokenHistoryRpc;
  repository: TokenHistoryRepository;
  loadMint(mint: PublicKey): Promise<TokenHistoryMintInfo>;
  inspectMarket(mint: PublicKey): Promise<TokenHistoryInspection | null>;
};

export function normalizeTokenHistoryRpcOptions(
  input: BackfillTokenHistoryOptions,
): NormalizedTokenHistoryRpcOptions {
  return {
    commitment: input.commitment ?? "finalized",
    pageSize: Math.max(1, Math.min(1_000, Math.trunc(input.pageSize ?? 1_000))),
    transactionBatchSize: Math.max(
      1,
      Math.min(100, Math.trunc(input.transactionBatchSize ?? 25)),
    ),
    transactionConcurrency: Math.max(
      1,
      Math.min(5, Math.trunc(input.transactionConcurrency ?? 1)),
    ),
    rpcTimeoutMs: Math.max(1_000, Math.trunc(input.rpcTimeoutMs ?? 20_000)),
    rpcRetries: Math.max(0, Math.min(10, Math.trunc(input.rpcRetries ?? 2))),
    retryDelayMs: Math.max(100, Math.trunc(input.retryDelayMs ?? 750)),
    maxSignaturesPerAddress: Math.max(
      0,
      Math.trunc(input.maxSignaturesPerAddress ?? 0),
    ),
    onProgress: input.onProgress,
  };
}

export async function runTokenHistoryBackfill(
  deps: TokenHistoryBackfillDependencies,
  mintInput: string,
  input: BackfillTokenHistoryOptions = {},
): Promise<TokenHistoryCoverage> {
  return measured(
    m,
    "backfill",
    async () => {
      let mint: PublicKey;
      try {
        mint = new PublicKey(mintInput.trim());
      } catch (error) {
        throw new TokenHistoryError("INVALID_INPUT", "Invalid token mint", {
          stage: "input",
          recoverable: false,
          cause: error,
        });
      }
      const mintText = mint.toBase58();
      const rpcOptions = normalizeTokenHistoryRpcOptions(input);

      const mintInfo = await measured(
        m,
        "read mint",
        () => deps.loadMint(mint),
        (row) => ({ decimals: row.decimals, supplyRaw: row.supply.toString() }),
      );
      const supplyUi = Number(mintInfo.supply) / 10 ** mintInfo.decimals;

      const inspected = await measured(
        m,
        "inspect pump",
        () => deps.inspectMarket(mint),
        (row) => ({
          supported: row?.bondingCurve != null,
          graduated: row?.pool != null,
        }),
      );
      if (!inspected?.bondingCurve) {
        throw new TokenHistoryError(
          "UNSUPPORTED_TOKEN",
          `Mint ${mintText} is not a supported Pump token`,
          { stage: "inspect", recoverable: false, context: { mint: mintText } },
        );
      }
      if (
        inspected.quoteMint &&
        inspected.quoteMint !== NATIVE_MINT.toBase58()
      ) {
        throw new TokenHistoryError(
          "UNSUPPORTED_TOKEN",
          `Historical research currently supports SOL-paired Pump tokens only`,
          {
            stage: "inspect",
            recoverable: false,
            context: { mint: mintText, quoteMint: inspected.quoteMint },
          },
        );
      }

      if (input.replace) deps.repository.replaceTrades(mintText);

      const curve = await deps.rpc.scanAddress(
        "curve",
        new PublicKey(inspected.bondingCurve),
        rpcOptions,
      );
      const pool = inspected.pool
        ? await deps.rpc.scanAddress(
            "pool",
            new PublicKey(inspected.pool),
            rpcOptions,
          )
        : null;
      const signatures = mergeTokenHistorySignatures(
        curve.rows,
        pool?.rows ?? [],
      );
      const fetched = await deps.rpc.fetchTransactions(signatures, rpcOptions);
      const parsedAtMs = deps.clock.nowMs();

      const parsed = measuredSync(
        m,
        "parse tape",
        () => {
          let creation: ReturnType<typeof findPumpHistoryCreateMarker> = null;
          let skippedNoTimestamp = 0;
          let skippedAmbiguous = 0;
          const trades: TokenHistoryTrade[] = [];

          for (let order = 0; order < signatures.length; order += 1) {
            const scan = signatures[order]!;
            const tx = fetched.bySignature.get(scan.signature);
            if (!tx) continue;
            if (!creation) {
              creation = findPumpHistoryCreateMarker(
                tx,
                scan.signature,
                mintText,
              );
            }
            if (tx.blockTime == null) {
              skippedNoTimestamp += 1;
              continue;
            }
            const result = parsePumpHistoryTransaction({
              tx,
              signature: scan.signature,
              mint: mintText,
              decimals: mintInfo.decimals,
              supplyUi,
              historyOrder: order,
              scanAddress: scan.scanAddress,
              scanKind: scan.scanKind,
              confidence: rpcOptions.commitment,
              updatedAtMs: parsedAtMs,
            });
            trades.push(...result.trades);
            skippedAmbiguous += result.ambiguous;
            if (
              order === 0 ||
              (order + 1) % 1_000 === 0 ||
              order + 1 === signatures.length
            ) {
              input.onProgress?.({
                phase: "parse",
                completed: order + 1,
                total: signatures.length,
                trades: trades.length,
                ambiguous: skippedAmbiguous,
              });
            }
          }
          return { creation, skippedNoTimestamp, skippedAmbiguous, trades };
        },
        (result) => ({
          signatures: signatures.length,
          trades: result.trades.length,
          ambiguous: result.skippedAmbiguous,
          noTimestamp: result.skippedNoTimestamp,
          creationFound: result.creation != null,
        }),
      );

      const persisted = deps.repository.persistTrades(
        parsed.trades,
        (progress) => input.onProgress?.({ phase: "store", ...progress }),
      );

      // Exact trades are the durable source of truth. Sparse 1s candles are a
      // materialized acceleration layer for repeated strategy simulations.
      const allTrades = deps.repository.loadTrades(mintText);
      const candles = measuredSync(
        m,
        "aggregate 1s candles",
        () => buildSparseTokenHistoryCandles1s(allTrades, parsedAtMs),
        (rows) => ({ trades: allTrades.length, candles: rows.length }),
      );
      deps.repository.replaceCandles1s(mintText);
      deps.repository.persistCandles1s(candles);
      input.onProgress?.({
        phase: "candles",
        trades: allTrades.length,
        candles: candles.length,
      });

      const fromCreation =
        curve.coverage.reachedStart && parsed.creation != null;
      const complete =
        fromCreation &&
        !curve.coverage.truncated &&
        (!pool || (pool.coverage.reachedStart && !pool.coverage.truncated)) &&
        fetched.missingTransactions === 0 &&
        fetched.failedTransactions === 0 &&
        parsed.skippedNoTimestamp === 0 &&
        parsed.skippedAmbiguous === 0;

      const coverage: TokenHistoryCoverage = {
        version: 1,
        mint: mintText,
        quoteMint: inspected.quoteMint ?? NATIVE_MINT.toBase58(),
        decimals: mintInfo.decimals,
        supplyRaw: mintInfo.supply.toString(),
        supplyUi,
        bondingCurve: inspected.bondingCurve,
        pool: inspected.pool ?? null,
        commitment: rpcOptions.commitment,
        curve: curve.coverage,
        pumpswap: pool?.coverage ?? null,
        uniqueSignatures: signatures.length,
        parsedTransactions: fetched.bySignature.size,
        missingTransactions: fetched.missingTransactions,
        failedTransactions: fetched.failedTransactions,
        skippedNoTimestamp: parsed.skippedNoTimestamp,
        skippedAmbiguous: parsed.skippedAmbiguous,
        storedTrades: deps.repository.countTrades(mintText),
        storedCandles1s: candles.length,
        insertedTrades: persisted.inserted,
        updatedTrades: persisted.updated,
        creationSignature: parsed.creation?.signature ?? null,
        creationAtMs: parsed.creation?.atMs ?? null,
        creationSlot: parsed.creation?.slot ?? null,
        creationName: parsed.creation?.name ?? null,
        creationSymbol: parsed.creation?.symbol ?? null,
        fromCreation,
        complete,
        updatedAtMs: deps.clock.nowMs(),
      };
      deps.repository.saveCoverage(coverage);
      return coverage;
    },
    (coverage) => ({
      mint: coverage.mint.slice(0, 8),
      complete: coverage.complete,
      fromCreation: coverage.fromCreation,
      signatures: coverage.uniqueSignatures,
      parsed: coverage.parsedTransactions,
      trades: coverage.storedTrades,
      missing: coverage.missingTransactions,
      failed: coverage.failedTransactions,
      ambiguous: coverage.skippedAmbiguous,
    }),
  );
}
