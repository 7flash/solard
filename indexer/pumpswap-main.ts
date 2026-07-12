#!/usr/bin/env bun
import {
  appendTokenTradeOnce,
  getTerminalToken,
  isSqliteBusyError,
  upsertProcessStatus,
} from "../shared/db.js";
import {
  compactId,
  dbMeasure,
  indexerMeasure,
  summarizeError,
} from "../shared/measure.js";
import {
  loadPumpSwapConfig,
  redactedUrl,
  USDC_MINT,
  WSOL_MINT,
} from "./pumpswap-config.js";
import { CanonicalPoolValidator, SolUsdOracle } from "./pumpswap-rpc.js";
import {
  extractPumpSwapCandidates,
  normalizeTransactionNotification,
} from "./pumpswap-transaction.js";
import type { PumpSwapCounters } from "./pumpswap-types.js";
import { runPumpSwapWsSession } from "./pumpswap-ws.js";

function createCounters(): PumpSwapCounters {
  return {
    sessions: 0,
    messages: 0,

    transactionNotifications: 0,

    logNotifications: 0,

    fetchedTransactions: 0,

    swapsSeen: 0,
    trades: 0,
    duplicateTrades: 0,

    unknownMints: 0,
    nonCanonicalPools: 0,
    unsupportedQuotes: 0,
    ambiguousSwaps: 0,
    skipped: 0,
    errors: 0,

    lastSignature: null,
    lastMint: null,
    lastTradeAtMs: null,

    solUsd: null,
    solUsdAtMs: null,

    mode: "transactionSubscribe",
  };
}

function statusDelayMs(attempt: number): number {
  return Math.min(500, 20 * 2 ** Math.max(0, attempt - 1));
}

async function writeStatus(
  input: Parameters<typeof upsertProcessStatus>[0],
): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      dbMeasure.sync(
        {
          start: () =>
            `db.upsert_process_status name=${compactId(input.name)} status=${input.status}`,

          end: (result: any) => ({
            updated: result != null,

            status: input.status,
          }),

          catch: summarizeError,
        },
        () => upsertProcessStatus(input),
      );

      return;
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= 5) {
        throw error;
      }

      await Bun.sleep(statusDelayMs(attempt));
    }
  }
}

export async function runPumpSwapIndexer(): Promise<void> {
  const config = loadPumpSwapConfig();

  const counters = createCounters();

  const controller = new AbortController();

  const poolValidator = new CanonicalPoolValidator(config);

  const solUsd = new SolUsdOracle(config);

  const knownTokens = new Map<
    string,
    {
      expiresAtMs: number;
      token: ReturnType<typeof getTerminalToken>;
    }
  >();

  const knownToken = (mint: string) => {
    const cached = knownTokens.get(mint);

    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.token;
    }

    const token = getTerminalToken(mint);

    knownTokens.set(mint, {
      token,

      expiresAtMs: Date.now() + (token ? 60_000 : 10_000),
    });

    return token;
  };

  let stopping = false;

  const stop = (reason: string) => {
    if (stopping) {
      return;
    }

    stopping = true;

    controller.abort();

    void writeStatus({
      name: config.name,

      kind: "indexer",

      status: "stopped",

      buildId: config.buildId,

      heartbeatAtMs: Date.now(),

      dataJson: JSON.stringify({
        reason,
        ...counters,
      }),

      updatedAtMs: Date.now(),
    }).catch(() => undefined);
  };

  process.once("SIGINT", () => stop("SIGINT"));

  process.once("SIGTERM", () => stop("SIGTERM"));

  const heartbeat = setInterval(() => {
    void writeStatus({
      name: config.name,

      kind: "indexer",

      status: "running",

      buildId: config.buildId,

      heartbeatAtMs: Date.now(),

      error: null,

      dataJson: JSON.stringify({
        programId: config.programId,

        ws: redactedUrl(config.wsUrl),

        ...counters,
      }),

      updatedAtMs: Date.now(),
    }).catch((error) => {
      console.error("[solard:pumpswap] heartbeat failed", error);
    });
  }, config.heartbeatMs);

  heartbeat.unref();

  await writeStatus({
    name: config.name,

    kind: "indexer",

    status: "starting",

    buildId: config.buildId,

    heartbeatAtMs: Date.now(),

    dataJson: JSON.stringify({
      programId: config.programId,

      ws: redactedUrl(config.wsUrl),
    }),

    updatedAtMs: Date.now(),
  });

  let reconnectMs = config.reconnectMinMs;

  try {
    while (!controller.signal.aborted) {
      try {
        await indexerMeasure.measure(
          {
            start: () => `pumpswap.session mode=${counters.mode}`,

            end: () => ({
              sessions: counters.sessions,

              trades: counters.trades,
            }),

            catch: summarizeError,
          },
          async () =>
            runPumpSwapWsSession(
              config,
              counters,
              controller.signal,
              async (message) => {
                const notification = normalizeTransactionNotification(message);

                const candidates = extractPumpSwapCandidates(
                  notification,
                  config.programId,
                );

                counters.swapsSeen += candidates.length;

                if (candidates.length === 0) {
                  counters.skipped++;
                  return;
                }

                for (const candidate of candidates) {
                  const token = knownToken(candidate.baseMint);

                  if (!token) {
                    counters.unknownMints++;

                    continue;
                  }

                  if (
                    candidate.quoteMint !== WSOL_MINT &&
                    candidate.quoteMint !== USDC_MINT
                  ) {
                    counters.unsupportedQuotes++;

                    continue;
                  }

                  const canonical = await poolValidator.validate(
                    candidate.pool,
                    candidate.baseMint,
                    candidate.quoteMint,
                  );

                  if (!canonical) {
                    counters.nonCanonicalPools++;

                    continue;
                  }

                  if (
                    candidate.baseAmountUi <= 0 ||
                    candidate.quoteAmountUi <= 0
                  ) {
                    counters.ambiguousSwaps++;

                    continue;
                  }

                  const currentSolUsd = await solUsd.get();

                  counters.solUsd = currentSolUsd;

                  counters.solUsdAtMs = Date.now();

                  let priceSol: number | null = null;

                  let priceUsd: number | null = null;

                  let volumeSol = 0;

                  if (candidate.quoteMint === WSOL_MINT) {
                    priceSol = candidate.quoteAmountUi / candidate.baseAmountUi;

                    priceUsd =
                      currentSolUsd != null ? priceSol * currentSolUsd : null;

                    volumeSol = candidate.quoteAmountUi;
                  } else {
                    priceUsd = candidate.quoteAmountUi / candidate.baseAmountUi;

                    priceSol =
                      currentSolUsd != null ? priceUsd / currentSolUsd : null;

                    volumeSol =
                      currentSolUsd != null
                        ? candidate.quoteAmountUi / currentSolUsd
                        : 0;
                  }

                  const marketCapUsd =
                    priceUsd != null && token.supplyUi > 0
                      ? priceUsd * token.supplyUi
                      : null;

                  const write = dbMeasure.sync(
                    {
                      start: () =>
                        `db.insert_pumpswap_trade mint=${compactId(candidate.baseMint)} pool=${compactId(candidate.pool)}`,

                      end: (result: any) => ({
                        inserted: result?.inserted === true,

                        side: candidate.side,

                        mcapUsd: marketCapUsd,
                      }),

                      catch: summarizeError,
                    },
                    () =>
                      appendTokenTradeOnce({
                        eventKey: `${candidate.signature}:pumpswap:${candidate.pool}:${candidate.side}`,

                        mint: candidate.baseMint,

                        signature: candidate.signature,

                        slot: candidate.slot,

                        owner: candidate.owner,

                        side: candidate.side,

                        tokenDeltaUi: candidate.baseAmountUi,

                        solDeltaUi: volumeSol,

                        priceSol,
                        priceUsd,
                        marketCapUsd,

                        confidence: candidate.confidence,

                        source: "helius-indexer-pumpswap",

                        rawJson: JSON.stringify({
                          pool: candidate.pool,

                          quoteMint: candidate.quoteMint,

                          instruction: candidate.instruction,

                          baseAmountUi: candidate.baseAmountUi,

                          quoteAmountUi: candidate.quoteAmountUi,

                          canonicalPoolIndex: 0,
                        }),

                        tradedAtMs: candidate.tradedAtMs,

                        updatedAtMs: Date.now(),
                      }),
                  );

                  if (write.inserted) {
                    counters.trades++;
                  } else {
                    counters.duplicateTrades++;
                  }

                  counters.lastSignature = candidate.signature;

                  counters.lastMint = candidate.baseMint;

                  counters.lastTradeAtMs = candidate.tradedAtMs;
                }
              },
            ),
        );

        reconnectMs = config.reconnectMinMs;
      } catch (error) {
        if (controller.signal.aborted) {
          break;
        }

        counters.errors++;

        console.error("[solard:pumpswap] session failed", error);

        await writeStatus({
          name: config.name,

          kind: "indexer",

          status: "reconnecting",

          buildId: config.buildId,

          heartbeatAtMs: Date.now(),

          error: error instanceof Error ? error.message : String(error),

          dataJson: JSON.stringify({
            reconnectMs,
            ...counters,
          }),

          updatedAtMs: Date.now(),
        }).catch(() => undefined);

        await Bun.sleep(reconnectMs);

        reconnectMs = Math.min(config.reconnectMaxMs, reconnectMs * 2);
      }
    }
  } finally {
    clearInterval(heartbeat);

    await writeStatus({
      name: config.name,

      kind: "indexer",

      status: "stopped",

      buildId: config.buildId,

      heartbeatAtMs: Date.now(),

      dataJson: JSON.stringify(counters),

      updatedAtMs: Date.now(),
    }).catch(() => undefined);
  }
}

if (import.meta.main) {
  await runPumpSwapIndexer();
}
