#!/usr/bin/env bun
import { Connection, PublicKey } from "@solana/web3.js";
import {
  dbWrite,
  getCursor,
  recomputeTerminalIndicators,
  setCursor,
  upsertProcessStatus,
  upsertTerminalToken,
} from "../db/terminal-store.js";
import {
  workerMeasure,
  measureRetry,
  summarizeForMeasure,
} from "../measure.js";
import { PUMP_PROGRAM_ID } from "../pump/parse-terminal-tx.js";
import { findPumpCreateInTransaction } from "../../pump/parsers/pump-create.js";
import { resolvedHeliusRpcUrl } from "../../chain/helius-history.js";

const NAME = "solard-pump-creates";
const POLL_MS = Math.max(
  500,
  Number(process.env.SOLARD_PUMP_CREATE_POLL_MS ?? "1500"),
);
const LIMIT = Math.max(
  1,
  Math.min(Number(process.env.SOLARD_PUMP_CREATE_BATCH ?? "30"), 100),
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
      start: () => "pump creates poll",
      end: (result) => ({ result: summarizeForMeasure(result) }),
      catch: (error) => {
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
      const cursor = getCursor(`${NAME}:before`) || undefined;
      const signatures = await measureRetry(
        "pump creates getSignaturesForAddress",
        { attempts: 4, delay: 150, backoff: 2 },
        () =>
          connection.getSignaturesForAddress(new PublicKey(PUMP_PROGRAM_ID), {
            limit: LIMIT,
            before: cursor,
          }),
      );
      if (!signatures.length) return { checked: 0, creates: 0, cursor };

      let creates = 0;
      const ordered = [...signatures].reverse();
      for (const sig of ordered) {
        const tx = await connection
          .getParsedTransaction(sig.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })
          .catch(() => null);
        if (!tx) continue;
        const found = findPumpCreateInTransaction(
          tx as any,
          sig.signature,
        ) as Record<string, unknown> | null;
        if (!found?.mint) continue;
        const mint = str(found.mint);
        if (!mint) continue;
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
        });
        creates++;
      }

      setCursor(`${NAME}:before`, signatures[0]!.signature);
      upsertProcessStatus({
        name: NAME,
        kind: "stream",
        status: "ok",
        data: {
          checked: signatures.length,
          creates,
          pollMs: POLL_MS,
          cursor: signatures[0]!.signature,
        },
      });
      return {
        checked: signatures.length,
        creates,
        cursor: signatures[0]!.signature,
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
    data: { pollMs: POLL_MS },
  });
  while (true) {
    try {
      await runTick(connection);
    } catch (error) {
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
  upsertProcessStatus({ name: NAME, kind: "stream", status: "fatal", error });
  throw error;
});
