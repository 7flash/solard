import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Connection } from "@solana/web3.js";

import { resetSolardRpcStats } from "../connection.ts";
import { SolanaTokenHistoryRpc } from "./rpc.ts";
import type {
  NormalizedTokenHistoryRpcOptions,
  TokenHistoryBackfillProgress,
  TokenHistoryScanSignature,
} from "./types.ts";

const originalFetch = globalThis.fetch;

function signature(index: number): TokenHistoryScanSignature {
  return {
    signature: `sig-${index}`,
    slot: index,
    err: null,
    memo: null,
    blockTime: 1_700_000_000 + index,
    confirmationStatus: "finalized",
    scanKind: "curve",
    scanAddress: "curve",
    localChronologicalOrder: index,
  };
}

function options(
  onProgress?: (progress: TokenHistoryBackfillProgress) => void,
): NormalizedTokenHistoryRpcOptions {
  return {
    commitment: "finalized",
    pageSize: 1_000,
    transactionBatchSize: 10,
    transactionConcurrency: 1,
    rpcTimeoutMs: 5_000,
    rpcRetries: 1,
    retryDelayMs: 100,
    maxSignaturesPerAddress: 0,
    onProgress,
  };
}

beforeEach(() => {
  resetSolardRpcStats();
  process.env.SLRD_RPC_MAX_RPS = "10000";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SLRD_RPC_MAX_RPS;
});

describe("SolanaTokenHistoryRpc transaction pipeline", () => {
  test("handles one 429 by backing off and splitting the batch", async () => {
    let calls = 0;
    const progress: TokenHistoryBackfillProgress[] = [];
    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body ?? "[]")) as Array<{
        id: number;
      }>;
      if (!Array.isArray(request)) {
        // The optional provider-specific fast path is outside this batch retry
        // test. Model a standard Solana RPC that rejects that method.
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "Method not found" },
        });
      }
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(
        JSON.stringify(
          request.map((row) => ({
            jsonrpc: "2.0",
            id: row.id,
            result: {
              slot: row.id,
              blockTime: 1_700_000_000,
              transaction: { message: { accountKeys: [], instructions: [] } },
              meta: { err: null, preBalances: [], postBalances: [] },
            },
          })),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const rpc = new SolanaTokenHistoryRpc({
      rpcEndpoint: "https://unit.test",
    } as Connection);
    const result = await rpc.fetchTransactions(
      Array.from({ length: 10 }, (_, index) => signature(index)),
      options((row) => progress.push(row)),
    );

    expect(calls).toBe(3);
    expect(result.bySignature.size).toBe(10);
    expect(result.failedTransactions).toBe(0);
    expect(result.missingTransactions).toBe(0);
    expect(
      progress.some(
        (row) =>
          row.phase === "throttle" &&
          row.reason === "rate-limit" &&
          row.batchSize === 10 &&
          row.nextBatchSize === 5,
      ),
    ).toBe(true);
  });
});
