#!/usr/bin/env bun
import { Connection, PublicKey } from "@solana/web3.js";
import {
  dbWrite,
  getCursor,
  insertTerminalTrade,
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
import {
  DEFAULT_PUMP_SUPPLY_UI,
  PUMP_PROGRAM_ID,
  parseTerminalTradesFromTransaction,
} from "../pump/parse-terminal-tx.js";
import { resolvedHeliusRpcUrl } from "../../chain/helius-history.js";

const NAME = "solard-pump-trades";
const POLL_MS = Math.max(
  500,
  Number(process.env.SOLARD_PUMP_TRADE_POLL_MS ?? "1200"),
);
const LIMIT = Math.max(
  1,
  Math.min(Number(process.env.SOLARD_PUMP_TRADE_BATCH ?? "40"), 100),
);
const SOL_USD_FALLBACK = Number(process.env.SOLARD_SOL_USD_FALLBACK ?? "150");

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

async function solUsd(): Promise<number | null> {
  // Keep this HTTP-only and bounded. A more exact quote source can replace it,
  // but terminal math should never block stream ingestion.
  const env = Number(process.env.SOLARD_SOL_USD);
  if (Number.isFinite(env) && env > 0) return env;
  return Number.isFinite(SOL_USD_FALLBACK) && SOL_USD_FALLBACK > 0
    ? SOL_USD_FALLBACK
    : null;
}

async function runTick(
  connection: Connection,
): Promise<Record<string, unknown>> {
  return await workerMeasure.measure(
    {
      start: () => "pump trades poll",
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
        "pump trades getSignaturesForAddress",
        { attempts: 4, delay: 150, backoff: 2 },
        () =>
          connection.getSignaturesForAddress(new PublicKey(PUMP_PROGRAM_ID), {
            limit: LIMIT,
            before: cursor,
          }),
      );
      if (!signatures.length)
        return { checked: 0, trades: 0, tokens: 0, cursor };

      const usd = await solUsd();
      let trades = 0;
      const touched = new Set<string>();
      for (const sig of [...signatures].reverse()) {
        const tx = await connection
          .getParsedTransaction(sig.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })
          .catch(() => null);
        if (!tx) continue;
        const parsed = parseTerminalTradesFromTransaction({
          tx: tx as any,
          signature: sig.signature,
          source: "helius-trade-poll",
          solUsd: usd,
        });
        for (const trade of parsed) {
          await dbWrite("record_terminal_trade", () => {
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
            recomputeTerminalIndicators(trade.mint);
          });
          trades++;
          touched.add(trade.mint);
        }
      }

      setCursor(`${NAME}:before`, signatures[0]!.signature);
      upsertProcessStatus({
        name: NAME,
        kind: "stream",
        status: "ok",
        data: {
          checked: signatures.length,
          trades,
          tokens: touched.size,
          pollMs: POLL_MS,
          cursor: signatures[0]!.signature,
        },
      });
      return {
        checked: signatures.length,
        trades,
        tokens: touched.size,
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
