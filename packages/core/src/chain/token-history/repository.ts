import { createSolardMeasure } from "../../core/log.ts";
import { measuredSync } from "../../core/measured.ts";
import {
  db,
  TokenHistoryCandle1sSchema,
  TokenTradeSchema,
  type TokenHistoryCandle1sRow,
  type TokenTrade,
} from "../../db.ts";
import { TokenHistoryError } from "./errors.ts";
import { compareTokenHistoryTrades } from "./ordering.ts";
import type {
  TokenHistoryCandle1s,
  TokenHistoryCoverage,
  TokenHistoryRaw,
  TokenHistoryTrade,
} from "./types.ts";

const m = createSolardMeasure("history:db");
const HISTORY_STATUS_PREFIX = "token-history:";
const PERSIST_BATCH_SIZE = 250;

type HistoryDatabase = typeof db;

export type PersistTokenHistoryResult = {
  inserted: number;
  updated: number;
};

export type TokenHistoryPersistProgress = {
  completed: number;
  total: number;
  inserted: number;
  updated: number;
};

export interface TokenHistoryRepository {
  loadTrades(mint: string): TokenHistoryTrade[];
  loadCandles1s(mint: string): TokenHistoryCandle1s[];
  countTrades(mint: string): number;
  getCoverage(mint: string): TokenHistoryCoverage | null;
  replaceTrades(mint: string): number;
  replaceCandles1s(mint: string): number;
  persistTrades(
    rows: readonly TokenHistoryTrade[],
    onProgress?: (progress: TokenHistoryPersistProgress) => void,
  ): PersistTokenHistoryResult;
  persistCandles1s(
    rows: readonly TokenHistoryCandle1s[],
  ): PersistTokenHistoryResult;
  saveCoverage(coverage: TokenHistoryCoverage): void;
}

function requiredMint(mintInput: string): string {
  const mint = mintInput.trim();
  if (!mint) {
    throw new TokenHistoryError("INVALID_INPUT", "Token mint is required", {
      stage: "repository",
      recoverable: false,
    });
  }
  return mint;
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

function toDomainTrade(row: TokenTrade): TokenHistoryTrade {
  return { ...row, history: parseHistoryRaw(row.rawJson) } as TokenHistoryTrade;
}

function toStoredTrade(row: TokenHistoryTrade): TokenTrade {
  const { history: _history, ...stored } = row;
  return TokenTradeSchema.parse(stored) as TokenTrade;
}

export class SqliteTokenHistoryRepository implements TokenHistoryRepository {
  constructor(private readonly database: HistoryDatabase = db) {}

  loadTrades(mintInput: string): TokenHistoryTrade[] {
    const mint = requiredMint(mintInput);
    return measuredSync(
      m,
      "load trades",
      () =>
        (
          this.database.tokenHistoryTradesV1
            .select()
            .where({ mint })
            .all() as TokenTrade[]
        )
          .map(toDomainTrade)
          .sort(compareTokenHistoryTrades),
      (rows) => ({ mint: mint.slice(0, 8), rows: rows.length }),
    );
  }

  loadCandles1s(mintInput: string): TokenHistoryCandle1s[] {
    const mint = requiredMint(mintInput);
    return measuredSync(
      m,
      "load 1s candles",
      () =>
        (
          this.database.tokenHistoryCandles1sV1
            .select()
            .where({ mint })
            .orderBy("bucketAtMs", "asc")
            .all() as TokenHistoryCandle1sRow[]
        ).map((row) => ({ ...row })),
      (rows) => ({ mint: mint.slice(0, 8), rows: rows.length }),
    );
  }

  countTrades(mintInput: string): number {
    const mint = requiredMint(mintInput);
    return measuredSync(
      m,
      "count trades",
      () =>
        (
          this.database.tokenHistoryTradesV1
            .select("eventKey")
            .where({ mint })
            .all() as Array<{ eventKey: string }>
        ).length,
      (rows) => ({ mint: mint.slice(0, 8), rows }),
    );
  }

  getCoverage(mintInput: string): TokenHistoryCoverage | null {
    const mint = mintInput.trim();
    if (!mint) return null;
    return measuredSync(
      m,
      "load coverage",
      () => {
        const row = this.database.processStatus
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
      },
      (coverage) => ({
        mint: mint.slice(0, 8),
        found: coverage != null,
        complete: coverage?.complete ?? false,
      }),
    );
  }

  replaceTrades(mintInput: string): number {
    const mint = requiredMint(mintInput);
    return measuredSync(
      m,
      "replace trades",
      () => this.database.tokenHistoryTradesV1.delete().where({ mint }).exec(),
      (deleted) => ({ mint: mint.slice(0, 8), deleted }),
    );
  }

  replaceCandles1s(mintInput: string): number {
    const mint = requiredMint(mintInput);
    return measuredSync(
      m,
      "replace 1s candles",
      () =>
        this.database.tokenHistoryCandles1sV1.delete().where({ mint }).exec(),
      (deleted) => ({ mint: mint.slice(0, 8), deleted }),
    );
  }

  persistTrades(
    rows: readonly TokenHistoryTrade[],
    onProgress?: (progress: TokenHistoryPersistProgress) => void,
  ): PersistTokenHistoryResult {
    let inserted = 0;
    let updated = 0;
    for (let offset = 0; offset < rows.length; offset += PERSIST_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + PERSIST_BATCH_SIZE);
      const result = measuredSync(
        m,
        "persist batch",
        () => {
          try {
            const keys = batch.map((row) => row.eventKey);
            const existing = new Set(
              (
                this.database.tokenHistoryTradesV1
                  .select("eventKey")
                  .whereIn("eventKey", keys)
                  .all() as Array<{ eventKey: string }>
              ).map((row) => row.eventKey),
            );
            this.database.transaction(() => {
              for (const row of batch) {
                const stored = toStoredTrade(row);
                this.database.tokenHistoryTradesV1.upsert(stored, {
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
              }
            });
            return {
              inserted: batch.filter((row) => !existing.has(row.eventKey))
                .length,
              updated: batch.filter((row) => existing.has(row.eventKey)).length,
            };
          } catch (error) {
            throw new TokenHistoryError(
              "PERSISTENCE_FAILED",
              "Failed to persist token-history batch",
              {
                stage: "persist",
                recoverable: true,
                context: { rows: batch.length },
                cause: error,
              },
            );
          }
        },
        (value) => ({
          rows: batch.length,
          inserted: value.inserted,
          updated: value.updated,
        }),
      );
      inserted += result.inserted;
      updated += result.updated;
      onProgress?.({
        completed: Math.min(offset + batch.length, rows.length),
        total: rows.length,
        inserted,
        updated,
      });
    }
    return { inserted, updated };
  }

  persistCandles1s(
    rows: readonly TokenHistoryCandle1s[],
  ): PersistTokenHistoryResult {
    let inserted = 0;
    let updated = 0;
    for (let offset = 0; offset < rows.length; offset += PERSIST_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + PERSIST_BATCH_SIZE);
      const result = measuredSync(
        m,
        "persist 1s candles batch",
        () => {
          const keys = batch.map((row) => row.candleKey);
          const existing = new Set(
            (
              this.database.tokenHistoryCandles1sV1
                .select("candleKey")
                .whereIn("candleKey", keys)
                .all() as Array<{ candleKey: string }>
            ).map((row) => row.candleKey),
          );
          this.database.transaction(() => {
            for (const row of batch) {
              const stored = TokenHistoryCandle1sSchema.parse(row);
              this.database.tokenHistoryCandles1sV1.upsert(stored, {
                on: "candleKey",
                merge: (table) => ({
                  openPriceSol: table.excluded("openPriceSol"),
                  highPriceSol: table.excluded("highPriceSol"),
                  lowPriceSol: table.excluded("lowPriceSol"),
                  closePriceSol: table.excluded("closePriceSol"),
                  volumeSol: table.excluded("volumeSol"),
                  volumeToken: table.excluded("volumeToken"),
                  buyVolumeSol: table.excluded("buyVolumeSol"),
                  sellVolumeSol: table.excluded("sellVolumeSol"),
                  buys: table.excluded("buys"),
                  sells: table.excluded("sells"),
                  trades: table.excluded("trades"),
                  firstSignature: table.excluded("firstSignature"),
                  lastSignature: table.excluded("lastSignature"),
                  firstSlot: table.excluded("firstSlot"),
                  lastSlot: table.excluded("lastSlot"),
                  updatedAtMs: table.excluded("updatedAtMs"),
                }),
              });
            }
          });
          return {
            inserted: batch.filter((row) => !existing.has(row.candleKey))
              .length,
            updated: batch.filter((row) => existing.has(row.candleKey)).length,
          };
        },
        (value) => ({ rows: batch.length, ...value }),
      );
      inserted += result.inserted;
      updated += result.updated;
    }
    return { inserted, updated };
  }

  saveCoverage(coverage: TokenHistoryCoverage): void {
    measuredSync(
      m,
      "save coverage",
      () => {
        const row = {
          name: `${HISTORY_STATUS_PREFIX}${coverage.mint}`,
          kind: "token-history-backfill",
          status: coverage.complete
            ? "complete"
            : coverage.fromCreation
              ? "partial"
              : "incomplete",
          heartbeatAtMs: coverage.updatedAtMs,
          pid: process.pid,
          buildId: null,
          error: null,
          dataJson: JSON.stringify({ coverage }),
          updatedAtMs: coverage.updatedAtMs,
        };
        this.database.processStatus.upsert(row, {
          on: "name",
          merge: (table) => ({
            kind: table.excluded("kind"),
            status: table.excluded("status"),
            heartbeatAtMs: table.max("heartbeatAtMs", 0),
            pid: table.excluded("pid"),
            buildId: table.excludedIfNotNull("buildId"),
            error: table.excluded("error"),
            dataJson: table.excluded("dataJson"),
            updatedAtMs: table.max("updatedAtMs", 0),
          }),
        });
        return coverage;
      },
      (row) => ({
        mint: row.mint.slice(0, 8),
        complete: row.complete,
        trades: row.storedTrades,
      }),
    );
  }
}

export const defaultTokenHistoryRepository = new SqliteTokenHistoryRepository();

// Compatibility façade for existing callers.
export const loadTokenHistoryTrades = (mint: string) =>
  defaultTokenHistoryRepository.loadTrades(mint);
export const loadTokenHistoryCandles1s = (mint: string) =>
  defaultTokenHistoryRepository.loadCandles1s(mint);
export const countTokenHistoryTrades = (mint: string) =>
  defaultTokenHistoryRepository.countTrades(mint);
export const getTokenHistoryCoverage = (mint: string) =>
  defaultTokenHistoryRepository.getCoverage(mint);
export const replaceTokenHistoryTrades = (mint: string) =>
  defaultTokenHistoryRepository.replaceTrades(mint);
export const replaceTokenHistoryCandles1s = (mint: string) =>
  defaultTokenHistoryRepository.replaceCandles1s(mint);
export const persistTokenHistoryTrades = (
  rows: readonly TokenHistoryTrade[],
  onProgress?: (progress: TokenHistoryPersistProgress) => void,
) => defaultTokenHistoryRepository.persistTrades(rows, onProgress);
export const persistTokenHistoryCandles1s = (
  rows: readonly TokenHistoryCandle1s[],
) => defaultTokenHistoryRepository.persistCandles1s(rows);
export const saveTokenHistoryCoverage = (coverage: TokenHistoryCoverage) =>
  defaultTokenHistoryRepository.saveCoverage(coverage);
