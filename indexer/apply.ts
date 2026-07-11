import { appendTokenTradeOnce, upsertTerminalToken } from "../shared/db.js";
import {
  compactId,
  dbMeasure,
  indexerMeasure,
  summarizeError,
} from "../shared/measure.js";
import type { IndexerConfig } from "./config.js";
import { enqueueMetadata } from "./metadata.js";
import { enqueueMayhemCheck } from "./mayhem.js";
import type { Counters, IndexedEvent } from "./types.js";

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
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
  return await indexerMeasure.measure(
    {
      start: () => `apply_events count=${events.length}`,

      end: (result: any) => ({
        applied: Number(result?.applied ?? 0),

        duplicateTrades: Number(result?.duplicateTrades ?? 0),
      }),

      catch: summarizeError,
    },
    async () => {
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
          dbMeasure.sync(
            {
              start: () => `db.upsert_token mint=${compactId(event.mint)}`,

              end: (result: any) => ({
                updated: result != null,
              }),

              catch: summarizeError,
            },
            () =>
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
          const tradeWrite = dbMeasure.sync(
            {
              start: () =>
                `db.insert_trade mint=${compactId(event.mint)} event=${compactId(event.eventKey)}`,

              end: (result: any) => ({
                event: compactId(result?.row?.eventKey ?? event.eventKey),

                inserted: result?.inserted === true,
              }),

              catch: summarizeError,
            },
            () =>
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
          dbMeasure.sync(
            {
              start: () => `db.complete_token mint=${compactId(event.mint)}`,

              end: (result: any) => ({
                updated: result != null,
              }),

              catch: summarizeError,
            },
            () =>
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

      input.counters.lastSignature =
        events[events.length - 1]?.signature ?? null;

      input.counters.lastEventAtMs = Date.now();

      return {
        applied,
        duplicateTrades,
      };
    },
  );
}
