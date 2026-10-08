import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Keypair } from "@solana/web3.js";
import {
  createLiveTradeHistoryRecorder,
  liveTradeHistoryRow,
} from "./live-trade-history.ts";
import { openDatabase, closeDatabase } from "../db/database.ts";
import { SqliteTokenHistoryRepository } from "../chain/token-history/repository.ts";
import { buildTokenBacktestTape } from "../backtest/tape.ts";
import type { TradeEvent } from "./launch-trades.ts";
export function historyEvent(
  mint: string,
  overrides: Partial<TradeEvent> = {},
): TradeEvent {
  return {
    type: "trade",
    mint,
    signature: "sig",
    pool: Keypair.generate().publicKey.toBase58(),
    eventIndex: 0,
    timestampSource: "observed",
    venue: "pumpswap",
    side: "buy",
    slot: 100,
    atMs: 1000200,
    baseRaw: 1000000n,
    quoteRaw: 10000000n,
    metadata: null,
    market: {
      quoteMint: "So11111111111111111111111111111111111111112",
      baseDecimals: 6,
      quoteDecimals: 9,
      supplyRaw: 1000000000000000n,
      supply: 1000000000,
      baseReserveRaw: 100000000n,
      quoteReserveRaw: 1000000000n,
      baseReserve: 100,
      quoteReserve: 1,
      priceQuotePerToken: 0.01,
      marketCapQuote: 10000000,
      priceSol: 0.01,
      marketCapSol: 10000000,
      solUsd: 100,
      solUsdSource: "provided",
      solUsdAtMs: 1000000,
      priceUsd: 1,
      marketCapUsd: 1000000000,
    },
    ...overrides,
  };
}
test("live history opens lazily, deduplicates event indexes, drains and loads into backtest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slrd-live-history-")),
    path = join(dir, "history.sqlite");
  const mint = Keypair.generate().publicKey.toBase58();
  const recorder = createLiveTradeHistoryRecorder({
    dbPath: path,
    flushIntervalMs: 10000,
  });
  try {
    expect(existsSync(path)).toBe(false);
    const event = historyEvent(mint);
    await recorder.record(event);
    await recorder.record(event);
    await recorder.record({ ...event, eventIndex: 1 }); // identical amount, different actual log
    expect(existsSync(path)).toBe(false);
    await recorder.close();
    const repository = new SqliteTokenHistoryRepository(openDatabase(path));
    const rows = repository.loadTrades(mint);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.confidence).toBe("processed");
    expect(JSON.parse(rows[0]!.rawJson).live).toMatchObject({
      eventIdentityComplete: true,
      timestampSource: "observed",
      collectionComplete: false,
      pool: event.pool,
    });
    const candles = repository.loadCandles1s(mint);
    expect(candles).toHaveLength(1);
    expect(candles[0]!.trades).toBe(2);
    const tape = buildTokenBacktestTape({
      mint,
      rows,
      historicalCoverage: repository.getCoverage(mint),
      options: { includeProcessed: true },
    });
    expect(tape.events).toHaveLength(2);
    expect(tape.coverage.backfillComplete).toBe(false);
    closeDatabase(path);
  } finally {
    await recorder.close();
    closeDatabase(path);
    rmSync(dir, { recursive: true, force: true });
  }
});
test("out-of-order events rebuild candles; replay keeps first observation and does not downgrade", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slrd-live-order-")),
    path = join(dir, "history.sqlite");
  const mint = Keypair.generate().publicKey.toBase58();
  const recorder = createLiveTradeHistoryRecorder({
    dbPath: path,
    commitment: "confirmed",
    batchSize: 1,
    flushIntervalMs: 10000,
  });
  try {
    const later = historyEvent(mint, { signature: "later", atMs: 1000900 });
    await recorder.record(later);
    const earlier = historyEvent(mint, {
      signature: "earlier",
      atMs: 1000100,
      market: { ...later.market, priceSol: 0.005 },
    });
    await recorder.record(earlier);
    await recorder.close();
    const processed = createLiveTradeHistoryRecorder({
      dbPath: path,
      commitment: "processed",
      batchSize: 1,
    });
    await processed.record({ ...later, atMs: 1010000 });
    await processed.close();
    const repository = new SqliteTokenHistoryRepository(openDatabase(path));
    const rows = repository.loadTrades(mint);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.tradedAtMs).toBe(1000900);
    expect(rows[1]!.confidence).toBe("confirmed");
    const candles = repository.loadCandles1s(mint);
    expect(candles).toHaveLength(1);
    expect(candles[0]!.openPriceSol).toBe(0.005);
    expect(candles[0]!.closePriceSol).toBe(0.01);
    closeDatabase(path);
  } finally {
    await recorder.close();
    closeDatabase(path);
    rmSync(dir, { recursive: true, force: true });
  }
});
test("unavailable SOL prices and quote principal remain unavailable without fabricated SOL volume", () => {
  const event = historyEvent(Keypair.generate().publicKey.toBase58());
  event.market = {
    ...event.market,
    quoteMint: Keypair.generate().publicKey.toBase58(),
    priceSol: null,
    priceUsd: null,
    marketCapSol: null,
    marketCapUsd: null,
  };
  const row = liveTradeHistoryRow(event)!;
  expect(row.priceSol).toBeNull();
  expect(row.solDeltaUi).toBe(0);
  expect(JSON.parse(row.rawJson).live.quoteRaw).toBe("10000000");
});

test("live appends preserve backfill rows and provenance while marking the collected tail partial", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slrd-live-coverage-")),
    path = join(dir, "history.sqlite");
  const mint = Keypair.generate().publicKey.toBase58();
  const repository = new SqliteTokenHistoryRepository(openDatabase(path));
  const old = liveTradeHistoryRow(
    historyEvent(mint, { signature: "backfilled", atMs: 999000 }),
    "finalized",
  )!;
  old.eventKey = "backfill-key";
  old.source = "rpc-backfill";
  repository.persistTrades([old]);
  repository.saveCoverage({
    version: 1,
    mint,
    complete: true,
    priceTapeComplete: true,
    fromCreation: true,
    creationSignature: "genesis",
    curve: { address: "original-curve" },
    updatedAtMs: 1,
  } as any);
  const recorder = createLiveTradeHistoryRecorder({
    dbPath: path,
    batchSize: 1,
  });
  try {
    await recorder.record(historyEvent(mint, { signature: "backfilled" })); // do not double-count a backfilled transaction
    const live = historyEvent(mint, { signature: "new-live" });
    await recorder.record(live);
    await recorder.close();
    expect(repository.loadTrades(mint)).toHaveLength(2);
    expect(repository.getCoverage(mint)).toMatchObject({
      complete: false,
      priceTapeComplete: false,
      fromCreation: true,
      creationSignature: "genesis",
      curve: { address: "original-curve" },
    });
    const upgraded = createLiveTradeHistoryRecorder({
      dbPath: path,
      commitment: "finalized",
      batchSize: 1,
    });
    await upgraded.record({ ...live, atMs: 1020000 });
    await upgraded.close();
    expect(
      repository.loadTrades(mint).find((row) => row.signature === "new-live")!
        .confidence,
    ).toBe("finalized");
    const replacement = {
      ...repository
        .loadTrades(mint)
        .find((row) => row.signature === "new-live")!,
      eventKey: "rpc-replacement",
      source: "rpc-backfill",
    };
    repository.persistTrades([replacement]);
    expect(
      repository.loadTrades(mint).filter((row) => row.signature === "new-live"),
    ).toHaveLength(1);
    expect(
      repository.loadTrades(mint).find((row) => row.signature === "new-live")!
        .source,
    ).toBe("rpc-backfill");
  } finally {
    await recorder.close();
    closeDatabase(path);
    rmSync(dir, { recursive: true, force: true });
  }
});
