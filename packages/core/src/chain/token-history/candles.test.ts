import { describe, expect, test } from "bun:test";

import { buildSparseTokenHistoryCandles1s } from "./candles.ts";
import type { TokenHistoryTrade } from "./types.ts";

function trade(
  id: string,
  at: number,
  side: "buy" | "sell",
  price: number,
  sol: number,
): TokenHistoryTrade {
  return {
    eventKey: id,
    mint: "mint",
    signature: `sig-${id}`,
    slot: at,
    owner: "owner",
    side,
    tokenDeltaUi: sol / price,
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
      ownerTokenDeltaRaw: "1",
      nativeWalletDeltaLamports: null,
      networkFeeLamports: "0",
      tokenAccountRentDeltaLamports: "0",
      wsolDeltaRaw: "0",
      economicQuoteDeltaLamports: null,
      pricingStatus: "native-wsol-corrected",
      excludedExternalTransfersLamports: "0",
      marketCapSol: null,
    },
  };
}

describe("buildSparseTokenHistoryCandles1s", () => {
  test("creates deterministic sparse OHLCV without filling empty seconds", () => {
    const rows = [
      trade("c", 3_100, "sell", 4, 3),
      trade("a", 1_100, "buy", 2, 1),
      trade("b", 1_900, "sell", 3, 2),
    ];
    const snapshot = structuredClone(rows);
    const candles = buildSparseTokenHistoryCandles1s(rows, 9_999);
    expect(candles).toHaveLength(2);
    expect(candles[0]).toMatchObject({
      bucketAtMs: 1_000,
      openPriceSol: 2,
      highPriceSol: 3,
      lowPriceSol: 2,
      closePriceSol: 3,
      volumeSol: 3,
      buyVolumeSol: 1,
      sellVolumeSol: 2,
      buys: 1,
      sells: 1,
      trades: 2,
    });
    expect(candles[1]?.bucketAtMs).toBe(3_000);
    expect(rows).toEqual(snapshot);
  });
});
