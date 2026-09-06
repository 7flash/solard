import { describe, expect, test } from "bun:test";

import { analyzeTokenHistoryTrades } from "./analysis.ts";
import type { TokenHistoryTrade } from "./types.ts";

function trade(
  eventKey: string,
  owner: string,
  side: "buy" | "sell",
  sol: number,
  tokens: number,
  at: number,
): TokenHistoryTrade {
  const price = sol / tokens;
  return {
    eventKey,
    mint: "mint",
    signature: `sig-${eventKey}`,
    slot: at,
    owner,
    side,
    tokenDeltaUi: tokens,
    solDeltaUi: sol,
    priceSol: price,
    priceUsd: null,
    marketCapUsd: null,
    confidence: "finalized",
    source: "history:pump-curve",
    rawJson: "{}",
    tradedAtMs: at,
    updatedAtMs: 1,
    history: {
      parserVersion: "test",
      venue: "pump-curve",
      instructionKinds: [side],
      instructionIndex: 0,
      historyOrder: at,
      scanAddress: "curve",
      scanKind: "curve",
      ownerTokenDeltaRaw: String(tokens),
      nativeWalletDeltaLamports: null,
      networkFeeLamports: "0",
      tokenAccountRentDeltaLamports: "0",
      wsolDeltaRaw: "0",
      economicQuoteDeltaLamports: null,
      pricingStatus: "native-wsol-corrected",
      excludedExternalTransfersLamports: "0",
      marketCapSol: price * 1_000_000,
    },
  };
}

describe("analyzeTokenHistoryTrades", () => {
  test("is pure and excludes owned wallets from first external buyer", () => {
    const rows = [
      trade("a", "ours", "buy", 1, 100, 1),
      trade("b", "external", "buy", 2, 100, 2),
      trade("c", "external", "sell", 1, 50, 3),
    ];
    const snapshot = structuredClone(rows);
    const result = analyzeTokenHistoryTrades({
      mint: "mint",
      trades: rows,
      coverage: null,
      ownedWallets: ["ours"],
    });
    expect(result.firstExternalBuyer?.owner).toBe("external");
    expect(result.roundTripTraders).toBe(1);
    expect(rows).toEqual(snapshot);
  });
});
