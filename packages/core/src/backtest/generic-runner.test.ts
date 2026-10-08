import { expect, test } from "bun:test";
import {
  runHistoricalStrategy,
  sweepHistoricalStrategies,
} from "./generic-runner.ts";
import {
  buildHistoricalCandles,
  loadHistoricalTradeTape,
} from "./historical.ts";
import type { BacktestTapeEvent } from "./strategy-sim.ts";
import type { TokenHistoryRepository } from "../chain/token-history/repository.ts";
import type { TokenHistoryTrade } from "../chain/token-history/types.ts";

function event(id: string, at: number, price: number): BacktestTapeEvent {
  return {
    id,
    signature: id,
    slot: at,
    tradedAtMs: at,
    priceSol: price,
    marketCapUsd: null,
    source: "fixture",
    confidence: "finalized",
  };
}

test("generic strategy fills at later observations and includes independent venue/network/tip costs", () => {
  const events = [
    event("trigger", 1000, 1),
    event("buy-fill", 2000, 2),
    event("sell-fill", 3000, 3),
  ];
  const result = runHistoricalStrategy(
    events,
    ({ index }) =>
      index === 0
        ? { side: "buy", sol: 1 }
        : index === 1
          ? { side: "sell", bps: 10000 }
          : null,
    { startingSol: 10, venueFeeBps: 100, networkFeeSol: 0.001, tipSol: 0.002 },
  );
  expect(result.fills.map((fill) => fill.fillEventId)).toEqual([
    "buy-fill",
    "sell-fill",
  ]);
  expect(result.fills[0]!.quantity).toBe(0.5);
  expect(result.summary.tokens).toBe(0);
  expect(result.summary.netPnlSol).toBeCloseTo(0.469, 10);
  expect(result.summary.venueFeeSol).toBeCloseTo(0.025, 10);
  expect(result.summary.networkFeeSol).toBe(0.002);
  expect(result.summary.tipSol).toBe(0.004);
  expect(result.capitalCurve).toHaveLength(3);
});

test("latency waits for a real later event; tail signals remain unfilled and zero funds cannot invent fills", () => {
  const events = [
    event("a", 1000, 1),
    event("b", 2000, 2),
    event("c", 3000, 3),
  ];
  const delayed = runHistoricalStrategy(
    events,
    ({ index }) => (index === 0 ? { side: "buy", sol: 1 } : null),
    { startingSol: 10, latencyMs: 1500, slippageBps: 1000 },
  );
  expect(delayed.fills[0]!.fillEventId).toBe("c");
  expect(delayed.fills[0]!.fillPriceSol).toBeCloseTo(3.3, 10);
  const tail = runHistoricalStrategy(
    events,
    ({ index }) => (index === 2 ? { side: "buy", sol: 1 } : null),
    { startingSol: 10 },
  );
  expect(tail.fills[0]!.status).toBe("unfilled");
  expect(tail.fills[0]!.reason).toBe("NO_LATER_PRICE");
  const denied = runHistoricalStrategy(
    events,
    ({ index }) => (index === 0 ? { side: "buy", sol: 10 } : null),
    { startingSol: 10, networkFeeSol: 1 },
  );
  expect(denied.fills[0]!.status).toBe("rejected");
  expect(denied.summary.cashSol).toBe(10);
});

test("sweeps instantiate isolated strategy state and sparse candles do not fabricate missing volume or periods", () => {
  const events = [event("a", 0, 1), event("b", 200, 2), event("c", 4000, 4)];
  const sweeps = sweepHistoricalStrategies(
    events,
    [1, 2],
    (sol) => {
      let called = false;
      return () => {
        if (called) return null;
        called = true;
        return { side: "buy", sol };
      };
    },
    { startingSol: 10 },
  );
  expect(sweeps.map((row) => row.result.fills[0]!.principalSol)).toEqual([
    1, 2,
  ]);
  const candles = buildHistoricalCandles(events);
  expect(candles.map((row) => row.bucketAtMs)).toEqual([0, 4000]);
  expect(candles[0]).toMatchObject({
    open: 1,
    high: 2,
    low: 1,
    close: 2,
    trades: 2,
    volumeSol: null,
  });
});

test("cached tape retains observed side/size and refuses missing prices and foreign mints", () => {
  const mint = "watched";
  const row = (id: string): TokenHistoryTrade =>
    ({
      eventKey: id,
      mint,
      signature: id,
      slot: 1,
      owner: null,
      side: "sell",
      tokenDeltaUi: -10,
      solDeltaUi: 1,
      priceSol: 0.1,
      confidence: "finalized",
      source: "fixture",
      tradedAtMs: 1000,
      updatedAtMs: 1000,
      history: {
        venue: "pumpswap",
        pricingStatus: "native-wsol-corrected",
        historyOrder: 1,
        instructionIndex: 1,
      },
    }) as TokenHistoryTrade;
  const valid = row("valid");
  const noPrice = row("missing");
  noPrice.priceSol = null;
  noPrice.history.pricingStatus = "missing";
  const wrong = row("foreign");
  wrong.mint = "another";
  const repository = {
    loadTrades: () => [valid, noPrice, wrong],
    getCoverage: () => ({
      complete: false,
      missingTransactions: 1,
      skippedAmbiguous: 2,
    }),
  } as unknown as TokenHistoryRepository;
  const tape = loadHistoricalTradeTape(mint, {}, repository);
  expect(tape.events).toHaveLength(1);
  expect(tape.events[0]).toMatchObject({
    side: "sell",
    tokenQuantityUi: 10,
    solNotional: 1,
    venue: "pumpswap",
  });
  expect(tape.completeness).toMatchObject({
    status: "partial",
    missingTransactions: 1,
    undecodedTransactions: 2,
    missingPrices: 1,
  });
});
