import { describe, expect, test } from "bun:test";

import type {
  TokenHistoryCoverage,
  TokenHistoryTrade,
} from "../chain/token-history/types.ts";
import { buildTokenBacktestTape } from "./tape.ts";

function historyTrade(
  eventKey: string,
  tradedAtMs: number,
  priceSol: number,
): TokenHistoryTrade {
  return {
    eventKey,
    mint: "Mint111111111111111111111111111111111111111",
    signature: `sig-${eventKey}`,
    slot: tradedAtMs,
    owner: "owner",
    side: "buy",
    tokenDeltaUi: 10,
    solDeltaUi: priceSol * 10,
    priceSol,
    priceUsd: null,
    marketCapUsd: null,
    confidence: "finalized",
    source: "history:pump-curve",
    rawJson: "{}",
    tradedAtMs,
    updatedAtMs: 123,
    history: {
      parserVersion: "test",
      venue: "pump-curve",
      instructionKinds: ["buy"],
      instructionIndex: 0,
      historyOrder: tradedAtMs,
      scanAddress: "curve",
      scanKind: "curve",
      ownerTokenDeltaRaw: "10",
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

const coverage = {
  creationAtMs: 900,
  creationSignature: "create",
  fromCreation: true,
  complete: true,
} as TokenHistoryCoverage;

describe("buildTokenBacktestTape", () => {
  test("is deterministic and independent from terminal DB metadata", () => {
    const rows = [
      historyTrade("a", 1_000, 0.01),
      historyTrade("b", 2_000, 0.02),
    ];
    const one = buildTokenBacktestTape({
      mint: rows[0]!.mint,
      rows,
      historicalCoverage: coverage,
    });
    const two = buildTokenBacktestTape({
      mint: rows[0]!.mint,
      rows,
      historicalCoverage: coverage,
    });
    expect(one).toEqual(two);
    expect(one.token).toBeNull();
    expect(one.coverage.provenFromCreation).toBe(true);
    expect(one.events.map((row) => row.priceSol)).toEqual([0.01, 0.02]);
  });

  test("filters without mutating source rows", () => {
    const rows = [
      historyTrade("a", 1_000, 0.01),
      historyTrade("b", 2_000, 0.02),
    ];
    const snapshot = structuredClone(rows);
    const tape = buildTokenBacktestTape({
      mint: rows[0]!.mint,
      rows,
      historicalCoverage: null,
      options: { fromMs: 1_500 },
    });
    expect(tape.events).toHaveLength(1);
    expect(rows).toEqual(snapshot);
  });
});
