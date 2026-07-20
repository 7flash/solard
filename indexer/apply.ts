import {
  appendTokenTradeOnce,
  getTerminalToken,
  upsertTerminalToken,
} from "../shared/db.js";
import {
  compactId,
  dbMeasure,
  indexerMeasure,
  summarizeError,
} from "../shared/measure.js";
import type { IndexerConfig } from "./config.ts";
import { enqueueMetadata } from "./metadata.ts";
import type { Counters, IndexedEvent, IndexedTrade } from "./types.ts";

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function updateKnownTradeToken(event: IndexedTrade): void {
  const existing = getTerminalToken(event.mint);
  if (!existing || Number(existing.observedAtMs ?? 0) <= 0) return;

  const eventAtMs =
    Number.isFinite(event.createdAtMs) && event.createdAtMs > 0
      ? event.createdAtMs
      : Date.now();

  upsertTerminalToken({
    mint: event.mint,
    source: "tracked-pump-trade",
    phase: existing.phase === "migrated" ? "migrated" : "pump",
    supplyUi: existing.supplyUi,
    priceSol: event.priceSol,
    priceUsd: event.priceUsd,
    marketCapSol: event.marketCapSol,
    marketCapUsd: event.marketCapUsd,
    signature: event.signature,
    lastSlot: event.slot,
    createdAtMs: existing.createdAtMs,
    observedAtMs: existing.observedAtMs,
    priceUpdatedAtMs: eventAtMs,
    updatedAtMs: Date.now(),
  });
}

export async function applyIndexedEvents(
  events: readonly IndexedEvent[],
  input: { config: IndexerConfig; counters: Counters },
): Promise<{ applied: number; duplicateTrades: number }> {
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
        return { applied: 0, duplicateTrades: 0 };
      }

      let applied = 0;
      let duplicateTrades = 0;

      for (const event of events) {
        if (event.kind === "create") {
          dbMeasure.sync(
            {
              start: () => `db.create_token mint=${compactId(event.mint)}`,
              end: (result: any) => ({ updated: result != null }),
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
                source: "pumpportal-create",
                phase: "pump",
                supplyUi: input.config.pumpSupplyUi,
                signature: event.signature,
                lastSlot: event.slot,
                createdAtMs: event.createdAtMs,
                observedAtMs: event.createdAtMs,
                updatedAtMs: Date.now(),
              }),
          );

          enqueueMetadata(input.config, input.counters, {
            mint: event.mint,
            uri: event.uri ?? "",
            name: event.name,
            symbol: event.symbol,
          });

          input.counters.creates++;
          applied++;
        } else if (event.kind === "trade") {
          const existing = getTerminalToken(event.mint);
          if (!existing || Number(existing.observedAtMs ?? 0) <= 0) {
            input.counters.rejectedUnknownTrades++;
            input.counters.skipped++;
            continue;
          }

          const tradeWrite = dbMeasure.sync(
            {
              start: () =>
                `db.insert_tracked_trade mint=${compactId(event.mint)} event=${compactId(event.eventKey)}`,
              end: (result: any) => ({ inserted: result?.inserted === true }),
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
                source: "tracked-pump-trade",
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

          updateKnownTradeToken(event);
          input.counters.trades++;
          input.counters.lastMcapUsd =
            event.marketCapUsd ?? input.counters.lastMcapUsd;
          applied++;
        } else {
          const existing = getTerminalToken(event.mint);
          if (!existing || Number(existing.observedAtMs ?? 0) <= 0) {
            input.counters.rejectedUnknownCompletes++;
            input.counters.skipped++;
            continue;
          }

          upsertTerminalToken({
            mint: event.mint,
            bondingCurveKey: event.bondingCurveKey ?? existing.bondingCurveKey,
            source: "pumpportal-migration",
            phase: "migrated",
            lastSlot: event.slot,
            signature: event.signature,
            updatedAtMs: Date.now(),
          });
          input.counters.completes++;
          applied++;
        }

        input.counters.lastMint = event.mint;
      }

      input.counters.lastSignature =
        events[events.length - 1]?.signature ?? null;
      input.counters.lastEventAtMs = Date.now();
      return { applied, duplicateTrades };
    },
  );
}
