#!/usr/bin/env bun
import { Connection } from "@solana/web3.js";
import {
  dbWrite,
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
import { findPumpCreateInTransaction } from "../../pump/parsers/pump-create.ts";
import { resolvedHeliusRpcUrl } from "../../chain/helius-history.ts";

const NAME = "solard-pump-creates";
const KIND = "pump-create-signature";
const POLL_MS = Math.max(
  500,
  Number(process.env.SOLARD_PUMP_CREATE_POLL_MS ?? "1200"),
);
const LIMIT = pollLimit("SOLARD_PUMP_CREATE_BATCH", 60, 100);
const RETAIN_SEEN_MS = Math.max(
  60_000,
  Number(process.env.SOLARD_TERMINAL_SEEN_RETAIN_MS ?? "3600000"),
);

function rpcUrl(): string {
  const value =
    resolvedHeliusRpcUrl() ||
    process.env.SOLANA_RPC_URL ||
    process.env.RPC_ENDPOINT;
  if (!value) throw new Error("Missing Helius/RPC URL for pump create worker");
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function runTick(
  connection: Connection,
): Promise<Record<string, unknown>> {
  return await workerMeasure.measure(
    {
      start: () => "pump creates live poll",
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
      if (!batch.signatures.length) {
        const pruned = pruneIngestionKeys(KIND, RETAIN_SEEN_MS);
        upsertProcessStatus({
          name: NAME,
          kind: "stream",
          status: "ok",
          data: {
            checked: 0,
            creates: 0,
            skippedSeen: batch.skippedSeen,
            newest: batch.newestSignature,
            pruned,
            pollMs: POLL_MS,
          },
        });
        return {
          checked: 0,
          creates: 0,
          skippedSeen: batch.skippedSeen,
          newest: batch.newestSignature,
          pruned,
        };
      }

      let creates = 0;
      let checked = 0;
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
            // Mark the signature as checked so the worker doesn't get pinned by unavailable txs.
            rememberIngestionKey(`${KIND}:${sig.signature}`, KIND);
            continue;
          }
          const found = findPumpCreateInTransaction(
            tx as any,
            sig.signature,
          ) as Record<string, unknown> | null;
          if (!found?.mint) {
            rememberIngestionKey(`${KIND}:${sig.signature}`, KIND);
            continue;
          }
          const mint = str(found.mint);
          if (!mint) {
            rememberIngestionKey(`${KIND}:${sig.signature}`, KIND);
            continue;
          }
          await dbWrite("record_pump_create", () => {
            upsertTerminalToken({
              mint,
              symbol: str(found.symbol) ?? "",
              name: str(found.name) ?? "",
              uri: str(found.uri),
              creator: str(found.creator) ?? str(found.traderPublicKey),
              bondingCurveKey: str(found.bondingCurveKey),
              source: "helius-create-poll",
              phase: "pump",
              signature: sig.signature,
              lastSlot: Number((tx as any).slot ?? sig.slot ?? 0),
              createdAtMs: Date.now(),
              updatedAtMs: Date.now(),
            });
            recomputeTerminalIndicators(mint);
            rememberIngestionKey(`${KIND}:${sig.signature}`, KIND);
          });
          creates++;
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
          creates,
          fresh: batch.freshCount,
          skippedSeen: batch.skippedSeen,
          newest: batch.newestSignature,
          previousNewest: batch.previousNewestSignature,
          pollMs: POLL_MS,
        },
      });
      return {
        checked,
        creates,
        fresh: batch.freshCount,
        skippedSeen: batch.skippedSeen,
        newest: batch.newestSignature,
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
