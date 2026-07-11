import {
  appendTokenTradeOnce,
  isSqliteBusyError,
  upsertTerminalToken,
} from "../shared/db.js";
import type { IndexerConfig } from "./config.js";
import { enqueueMetadata } from "./metadata.js";
import { enqueueMayhemCheck } from "./mayhem.js";
import type { Counters, IndexedEvent } from "./types.js";

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sqliteWrite<T>(label: string, operation: () => T): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= 7) {
        throw error;
      }

      attempt++;

      const delay = Math.min(250, 5 * 2 ** attempt);

      console.warn(
        `[solard:indexer] SQLite busy during ${label}; retry ${attempt} in ${delay}ms`,
      );

      await sleep(delay);
    }
  }
}

export async function applyIndexedEvents(
  events: readonly IndexedEvent[],
  input: {
    config: IndexerConfig;
    counters: Counters;
  },
): Promise<{
  applied: number;
  duplicateTrades: number;
}> {
  if (!events.length) {
    input.counters.skipped++;

    return {
      applied: 0,
      duplicateTrades: 0,
    };
  }

  let applied = 0;
  let duplicateTrades = 0;

  for (const event of events) {
    if (event.kind === "create") {
      await sqliteWrite("create token", () =>
        upsertTerminalToken({
          mint: event.mint,

          name: event.name,

          symbol: event.symbol,

          uri: event.uri,

          creator: event.creator,

          bondingCurveKey: event.bondingCurveKey,

          source: "helius-indexer-create",

          phase: "pump",

          supplyUi: input.config.pumpSupplyUi,

          signature: event.signature,

          lastSlot: event.slot,

          createdAtMs: event.createdAtMs,

          observedAtMs: event.createdAtMs,

          updatedAtMs: Date.now(),
        }),
      );

      enqueueMayhemCheck(input.config, input.counters, {
        mint: event.mint,

        bondingCurveKey: event.bondingCurveKey ?? null,

        attempt: 0,
      });

      enqueueMetadata(input.config, input.counters, {
        mint: event.mint,

        uri: event.uri ?? "",

        name: event.name,

        symbol: event.symbol,
      });

      input.counters.creates++;
      applied++;
    } else if (event.kind === "trade") {
      /**
       * The trade hot path is append-only. Current price, market cap, and SMA
       * windows are read from tokenPriceWindows; no token-state update or
       * aggregation runs here.
       */
      const tradeWrite = await sqliteWrite("append trade", () =>
        appendTokenTradeOnce({
          eventKey: event.eventKey,

          mint: event.mint,

          signature: event.signature,

          slot: event.slot,

          owner: event.owner,

          side: event.side,

          tokenDeltaUi: event.tokenDeltaUi,

          solDeltaUi: event.solDeltaUi,

          priceSol: event.priceSol,

          priceUsd: event.priceUsd,

          marketCapUsd: event.marketCapUsd,

          confidence: "processed",

          source: "helius-indexer-trade",

          rawJson: json(event.raw),

          tradedAtMs: event.createdAtMs,

          updatedAtMs: Date.now(),
        }),
      );

      if (!tradeWrite.inserted) {
        duplicateTrades++;

        input.counters.duplicateTrades++;

        continue;
      }

      input.counters.trades++;

      input.counters.lastMcapUsd =
        event.marketCapUsd ?? input.counters.lastMcapUsd;

      applied++;
    } else {
      await sqliteWrite("complete token", () =>
        upsertTerminalToken({
          mint: event.mint,

          bondingCurveKey: event.bondingCurveKey,

          source: "helius-indexer-complete",

          phase: "migrated",

          lastSlot: event.slot,

          signature: event.signature,

          updatedAtMs: Date.now(),
        }),
      );

      input.counters.completes++;
      applied++;
    }

    input.counters.lastMint = event.mint;
  }

  input.counters.lastSignature = events[events.length - 1]?.signature ?? null;

  input.counters.lastEventAtMs = Date.now();

  return {
    applied,
    duplicateTrades,
  };
}
