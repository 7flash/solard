import { describe, expect, test } from "bun:test";

import { analyzeTokenHistoryForensics } from "./forensics.ts";
import type { TokenHistoryCoverage, TokenHistoryTrade } from "./types.ts";

function trade(args: {
  id: string;
  owner: string;
  side: "buy" | "sell";
  sol: number;
  tokens: number;
  at: number;
  slot: number;
  order: number;
  feeLamports?: string;
  externalLamports?: string;
}): TokenHistoryTrade {
  return {
    eventKey: args.id,
    mint: "mint",
    signature: `sig-${args.id}`,
    slot: args.slot,
    owner: args.owner,
    side: args.side,
    tokenDeltaUi: args.tokens,
    solDeltaUi: args.sol,
    priceSol: args.sol / args.tokens,
    priceUsd: null,
    marketCapUsd: null,
    confidence: "finalized",
    source: "history:pump-curve",
    rawJson: "{}",
    tradedAtMs: args.at,
    updatedAtMs: args.at,
    history: {
      parserVersion: "test",
      venue: "pump-curve",
      instructionKinds: [args.side],
      instructionIndex: 0,
      historyOrder: args.order,
      scanAddress: "curve",
      scanKind: "curve",
      ownerTokenDeltaRaw: String(args.tokens),
      nativeWalletDeltaLamports: null,
      networkFeeLamports: args.feeLamports ?? "0",
      tokenAccountRentDeltaLamports: "0",
      wsolDeltaRaw: "0",
      economicQuoteDeltaLamports: null,
      pricingStatus: "native-wsol-corrected",
      excludedExternalTransfersLamports: args.externalLamports ?? "0",
      marketCapSol: null,
    },
  };
}

const coverage: TokenHistoryCoverage = {
  version: 1,
  mint: "mint",
  quoteMint: "sol",
  decimals: 6,
  supplyRaw: "1000000",
  supplyUi: 1,
  bondingCurve: "curve",
  pool: null,
  commitment: "finalized",
  curve: {
    kind: "curve",
    address: "curve",
    pages: 1,
    signatures: 4,
    oldestSignature: null,
    oldestSlot: null,
    oldestBlockTime: null,
    newestSignature: null,
    newestSlot: null,
    newestBlockTime: null,
    reachedStart: true,
    truncated: false,
  },
  pumpswap: null,
  uniqueSignatures: 4,
  parsedTransactions: 4,
  missingTransactions: 0,
  failedTransactions: 0,
  skippedNoTimestamp: 0,
  skippedAmbiguous: 0,
  storedTrades: 4,
  storedCandles1s: 2,
  insertedTrades: 4,
  updatedTrades: 0,
  creationSignature: "create",
  creationAtMs: 1_000,
  creationSlot: 9,
  creationName: "Token",
  creationSymbol: "T",
  fromCreation: true,
  complete: true,
  updatedAtMs: 9_999,
};

describe("analyzeTokenHistoryForensics", () => {
  test("ranks our first buy behind external buyers and calculates FIFO pnl", () => {
    const rows = [
      trade({
        id: "a",
        owner: "external-a",
        side: "buy",
        sol: 1,
        tokens: 100,
        at: 1_000,
        slot: 10,
        order: 1,
      }),
      trade({
        id: "b",
        owner: "external-b",
        side: "buy",
        sol: 2,
        tokens: 100,
        at: 1_000,
        slot: 10,
        order: 2,
      }),
      trade({
        id: "c",
        owner: "ours",
        side: "buy",
        sol: 3,
        tokens: 100,
        at: 2_000,
        slot: 11,
        order: 3,
        feeLamports: "5000",
        externalLamports: "1000000",
      }),
      trade({
        id: "d",
        owner: "ours",
        side: "sell",
        sol: 5,
        tokens: 50,
        at: 12_000,
        slot: 20,
        order: 4,
        feeLamports: "5000",
      }),
    ];
    const result = analyzeTokenHistoryForensics({
      mint: "mint",
      trades: rows,
      coverage,
      ownedWallets: ["ours"],
    });
    expect(result.ownedEntries[0]?.buyRank).toBe(3);
    expect(result.ownedEntries[0]?.externalBuysAhead).toBe(2);
    expect(result.ownedEntries[0]?.externalBuySolAhead).toBe(3);
    expect(result.ownedEntries[0]?.firstBuyDeltaMs).toBe(1_000);
    expect(result.ownedEntries[0]?.slotDeltaFromFirstBuy).toBe(1);
    expect(result.ownedPnl[0]?.realizedPnlSol).toBeCloseTo(3.5, 9);
    expect(result.ownedPnl[0]?.remainingCostSol).toBeCloseTo(1.5, 9);
    expect(result.ownedPnl[0]?.unrealizedPnlSol).toBeCloseTo(3.5, 9);
    expect(result.ownedPnl[0]?.totalPnlSol).toBeCloseTo(7, 9);
    expect(result.ownedPnl[0]?.recordedExecutionCostsSol).toBeCloseTo(
      0.00101,
      9,
    );
    expect(
      result.periods.find((row) => row.id === "5-15s")?.ownedRealizedPnlSol,
    ).toBeCloseTo(3.5, 9);
  });

  test("flags incomplete cost basis instead of ranking transfer-in sellers as winners", () => {
    const rows = [
      trade({
        id: "a",
        owner: "buyer",
        side: "buy",
        sol: 1,
        tokens: 100,
        at: 1_000,
        slot: 10,
        order: 1,
      }),
      trade({
        id: "b",
        owner: "airdrop",
        side: "sell",
        sol: 10,
        tokens: 100,
        at: 2_000,
        slot: 11,
        order: 2,
      }),
    ];
    const result = analyzeTokenHistoryForensics({
      mint: "mint",
      trades: rows,
      coverage,
    });
    const airdrop = result.ownerPnl.find((row) => row.owner === "airdrop")!;
    expect(airdrop.costBasisComplete).toBe(false);
    expect(result.topTotalWinners.some((row) => row.owner === "airdrop")).toBe(
      false,
    );
  });
});
