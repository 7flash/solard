#!/usr/bin/env bun
import { Connection } from "@solana/web3.js";
import {
  pendingTradeSignatures,
  updateTradeConfidence,
  upsertProcessStatus,
} from "../db/terminal-store.js";
import {
  workerMeasure,
  measureRetry,
  summarizeForMeasure,
} from "../measure.js";
import { resolvedHeliusRpcUrl } from "../../chain/helius-history.js";

const NAME = "solard-reconciler";
const BUILD_ID = "reconciler-v3-build-heartbeat";
const POLL_MS = Math.max(
  1000,
  Number(process.env.SOLARD_RECONCILER_POLL_MS ?? "2500"),
);

function rpcUrl(): string {
  const value =
    resolvedHeliusRpcUrl() ||
    process.env.SOLANA_RPC_URL ||
    process.env.RPC_ENDPOINT;
  if (!value) throw new Error("Missing Helius/RPC URL for reconciler worker");
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextConfidence(
  status: any,
): "confirmed" | "finalized" | "dropped" | null {
  if (!status) return null;
  if (status.err) return "dropped";
  if (status.confirmationStatus === "finalized") return "finalized";
  if (status.confirmationStatus === "confirmed") return "confirmed";
  return null;
}

async function tick(connection: Connection): Promise<Record<string, unknown>> {
  return await workerMeasure.measure(
    {
      start: () => "reconcile terminal trades",
      end: (result) => ({ result: summarizeForMeasure(result) }),
      catch: (error) => {
        upsertProcessStatus({
          name: NAME,
          kind: "reconciler",
          status: "error",
          error,
          data: { buildId: BUILD_ID },
        });
        throw error;
      },
    },
    async () => {
      const sigs = pendingTradeSignatures(100);
      if (!sigs.length) {
        upsertProcessStatus({
          name: NAME,
          kind: "reconciler",
          status: "ok",
          data: { checked: 0, updated: 0, pollMs: POLL_MS, buildId: BUILD_ID },
        });
        return { checked: 0, updated: 0 };
      }
      const statuses = await measureRetry(
        "reconciler getSignatureStatuses",
        { attempts: 4, delay: 150, backoff: 2 },
        () =>
          connection.getSignatureStatuses(sigs, {
            searchTransactionHistory: true,
          }),
      );
      let updated = 0;
      for (let i = 0; i < sigs.length; i++) {
        const confidence = nextConfidence(statuses.value[i]);
        if (!confidence) continue;
        updateTradeConfidence(sigs[i]!, confidence);
        updated++;
      }
      upsertProcessStatus({
        name: NAME,
        kind: "reconciler",
        status: "ok",
        data: {
          checked: sigs.length,
          updated,
          pollMs: POLL_MS,
          buildId: BUILD_ID,
        },
      });
      return { checked: sigs.length, updated };
    },
  );
}

async function main(): Promise<void> {
  const connection = new Connection(rpcUrl(), "confirmed");
  upsertProcessStatus({
    name: NAME,
    kind: "reconciler",
    status: "starting",
    data: { pollMs: POLL_MS, buildId: BUILD_ID },
  });
  while (true) {
    try {
      await tick(connection);
    } catch (error) {
      upsertProcessStatus({
        name: NAME,
        kind: "reconciler",
        status: "error",
        error,
        data: { buildId: BUILD_ID },
      });
      await sleep(Math.max(POLL_MS, 3000));
    }
    await sleep(POLL_MS);
  }
}

process.on("SIGINT", () => {
  upsertProcessStatus({
    name: NAME,
    kind: "reconciler",
    status: "stopped",
    data: { reason: "SIGINT", buildId: BUILD_ID },
  });
  process.exit(0);
});
process.on("SIGTERM", () => {
  upsertProcessStatus({
    name: NAME,
    kind: "reconciler",
    status: "stopped",
    data: { reason: "SIGTERM", buildId: BUILD_ID },
  });
  process.exit(0);
});

main().catch((error) => {
  upsertProcessStatus({
    name: NAME,
    kind: "reconciler",
    status: "fatal",
    error,
    data: { buildId: BUILD_ID },
  });
  throw error;
});
