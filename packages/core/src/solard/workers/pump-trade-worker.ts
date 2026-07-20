#!/usr/bin/env bun
import { Connection } from "@solana/web3.js";
import {
  dbWrite,
  insertTerminalTrade,
  recomputeTerminalIndicators,
  upsertProcessStatus,
  upsertTerminalToken,
} from "@solard/core/db.js";
import {
  pruneIngestionKeys,
  recordWorkerError,
  rememberIngestionKey,
} from "../db/terminal-ingestion.ts";
import { workerMeasure, summarizeForMeasure } from "../measure.ts";
import {
  pollLatestPumpSignatures,
  pollLimit,
} from "../pump/pump-program-poll.ts";
import {
  DEFAULT_PUMP_SUPPLY_UI,
  parseTerminalTradesFromTransaction,
} from "../pump/parse-terminal-tx.ts";
import { resolveSolUsd } from "../prices/sol-usd.ts";
import { resolvedHeliusRpcUrl } from "../../chain/helius-history.ts";

const NAME = "solard-pump-trades";
const KIND = "pump-trade-signature";
const POLL_MS = Math.max(
  500,
  Number(process.env.SOLARD_PUMP_TRADE_POLL_MS ?? "1000"),
);
const LIMIT = pollLimit("SOLARD_PUMP_TRADE_BATCH", 75, 100);
const RETAIN_SEEN_MS = Math.max(
  60_000,
  Number(process.env.SOLARD_TERMINAL_SEEN_RETAIN_MS ?? "3600000"),
);

function rpcUrl(): string {
  const value =
    resolvedHeliusRpcUrl() ||
    process.env.SOLANA_RPC_URL ||
    process.env.RPC_ENDPOINT;
  if (!value) throw new Error("Missing Helius/RPC URL for pump trade worker");
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTick(
  connection: Connection,
): Promise<Record<string, unknown>> {
  return await workerMeasure.measure(
    {
      start: () => "pump trades live poll",
      end: (result) => ({ result: summarizeForMeasure(result) }),
      catch: (error) => {
        recordWorkerError(NAME, error);
        upsertProcessStatus({
          name: NAME,
          kind: "stream",
          status: "error",
          error,
        });
        throw error;
      },
    },
    async () => {
      const batch = await pollLatestPumpSignatures({
        connection,
        workerName: NAME,
        kind: KIND,
        limit: LIMIT,
      });
      const solUsd = await resolveSolUsd();
      if (!batch.signatures.length) {
        const pruned = pruneIngestionKeys(KIND, RETAIN_SEEN_MS);
        upsertProcessStatus({
          name: NAME,
          kind: "stream",
          status: "ok",
          data: {
            checked: 0,
            trades: 0,
            tokens: 0,
            skippedSeen: batch.skippedSeen,
            newest: batch.newestSignature,
            solUsd,
            pruned,
            pollMs: POLL_MS,
          },
        });
        return {
          checked: 0,
          trades: 0,
          tokens: 0,
          skippedSeen: batch.skippedSeen,
          newest: batch.newestSignature,
          solUsd,
          pruned,
        };
      }

      let checked = 0;
      let trades = 0;
      const touched = new Set<string>();
      for (const sig of batch.signatures) {
        checked++;
        try {
          const tx = await connection
            .getParsedTransaction(sig.signature, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            })
            .catch(() => null);
          if (!tx) {
            rememberIngestionKey(`${KIND}:${sig.signature}`, KIND);
            continue;
          }
          const parsed = parseTerminalTradesFromTransaction({
            tx: tx as any,
            signature: sig.signature,
            source: "helius-trade-poll",
            solUsd,
          });
          await dbWrite("record_terminal_trade_batch", () => {
            for (const trade of parsed) {
              insertTerminalTrade({ ...trade, confidence: "processed" });
              upsertTerminalToken({
                mint: trade.mint,
                source: "helius-trade-poll",
                supplyUi: DEFAULT_PUMP_SUPPLY_UI,
                priceSol: trade.priceSol,
                priceUsd: trade.priceUsd,
                marketCapUsd: trade.marketCapUsd,
                marketCapSol:
                  trade.priceSol != null
                    ? trade.priceSol * DEFAULT_PUMP_SUPPLY_UI
                    : null,
                lastSlot: trade.slot,
                signature: trade.signature,
                updatedAtMs: trade.createdAtMs,
              });
              touched.add(trade.mint);
              trades++;
            }
            for (const mint of touched) recomputeTerminalIndicators(mint);
            rememberIngestionKey(`${KIND}:${sig.signature}`, KIND);
          });
        } catch (error) {
          recordWorkerError(NAME, error, { signature: sig.signature });
        }
      }

      upsertProcessStatus({
        name: NAME,
        kind: "stream",
        status: "ok",
        data: {
          checked,
          trades,
          tokens: touched.size,
          fresh: batch.freshCount,
          skippedSeen: batch.skippedSeen,
          newest: batch.newestSignature,
          previousNewest: batch.previousNewestSignature,
          solUsd,
          pollMs: POLL_MS,
        },
      });
      return {
        checked,
        trades,
        tokens: touched.size,
        fresh: batch.freshCount,
        skippedSeen: batch.skippedSeen,
        newest: batch.newestSignature,
        solUsd,
      };
    },
  );
}

async function main(): Promise<void> {
  const connection = new Connection(rpcUrl(), "confirmed");
  upsertProcessStatus({
    name: NAME,
    kind: "stream",
    status: "starting",
    data: { pollMs: POLL_MS, mode: "latest-head-poll" },
  });
  while (true) {
    try {
      await runTick(connection);
    } catch (error) {
      recordWorkerError(NAME, error);
      upsertProcessStatus({
        name: NAME,
        kind: "stream",
        status: "error",
        error,
      });
      await sleep(Math.max(POLL_MS, 3000));
    }
    await sleep(POLL_MS);
  }
}

main().catch((error) => {
  recordWorkerError(NAME, error);
  upsertProcessStatus({ name: NAME, kind: "stream", status: "fatal", error });
  throw error;
});
