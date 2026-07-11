import type {
  TerminalDatabase,
  TerminalTradeData,
} from "../shared/terminal-db.js";
import {
  recomputeIndicators,
  rememberIngestionKey,
  upsertTerminalToken,
  upsertTerminalTrade,
} from "../shared/terminal-repo.js";
import type { IndexerConfig } from "./config.js";
import { enqueueMetadata } from "./metadata.js";
import type { Counters, IndexedEvent } from "./types.js";

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

export function applyIndexedEvents(
  db: TerminalDatabase,
  events: IndexedEvent[],
  input: {
    signature: string;
    supplyUi: number;
    config: IndexerConfig;
    counters: Counters;
  },
): {
  applied: number;
  duplicate: boolean;
} {
  if (!events.length) {
    input.counters.skipped++;
    return { applied: 0, duplicate: false };
  }

  const fresh = rememberIngestionKey(
    `helius-indexer:${input.signature}`,
    "helius-indexer",
    db,
  );

  if (!fresh) {
    input.counters.duplicates++;
    return { applied: 0, duplicate: true };
  }

  const touched = new Set<string>();
  let applied = 0;

  for (const event of events) {
    if (event.kind === "create") {
      upsertTerminalToken(
        {
          mint: event.mint,
          name: event.name,
          symbol: event.symbol,
          uri: event.uri,
          creator: event.creator,
          bondingCurveKey: event.bondingCurveKey,
          source: "helius-indexer-create",
          phase: "pump",
          supplyUi: input.supplyUi,
          signature: event.signature,
          lastSlot: event.slot,
          rawJson: json(event.raw),
          createdAtMs: event.createdAtMs,
          updatedAtMs: Date.now(),
        },
        db,
      );

      enqueueMetadata(
        {
          db,
          config: input.config,
          counters: input.counters,
        },
        {
          mint: event.mint,
          uri: event.uri ?? "",
          name: event.name,
          symbol: event.symbol,
        },
      );

      input.counters.creates++;
    } else if (event.kind === "trade") {
      const trade: TerminalTradeData = {
        eventKey: event.eventKey,
        mint: event.mint,
        signature: event.signature,
        slot: event.slot,
        owner: event.owner ?? null,
        side: event.side,
        tokenDeltaUi: event.tokenDeltaUi ?? 0,
        solDeltaUi: event.solDeltaUi ?? 0,
        priceSol: event.priceSol,
        priceUsd: event.priceUsd,
        marketCapUsd: event.marketCapUsd,
        confidence: "processed",
        source: "helius-indexer-trade",
        rawJson: json(event.raw),
        createdAtMs: event.createdAtMs,
        updatedAtMs: Date.now(),
      };

      upsertTerminalTrade(trade, db);

      upsertTerminalToken(
        {
          mint: event.mint,
          source: "helius-indexer-trade",
          phase: "pump",
          supplyUi: input.supplyUi,
          priceSol: event.priceSol,
          priceUsd: event.priceUsd,
          marketCapSol: event.marketCapSol,
          marketCapUsd: event.marketCapUsd,
          lastSlot: event.slot,
          signature: event.signature,
          priceUpdatedAtMs: Date.now(),
          updatedAtMs: Date.now(),
        },
        db,
      );

      input.counters.trades++;
      input.counters.lastMcapUsd =
        event.marketCapUsd ?? input.counters.lastMcapUsd;
    } else {
      upsertTerminalToken(
        {
          mint: event.mint,
          bondingCurveKey: event.bondingCurveKey,
          source: "helius-indexer-complete",
          phase: "migrated",
          lastSlot: event.slot,
          signature: event.signature,
          updatedAtMs: Date.now(),
        },
        db,
      );

      input.counters.completes++;
    }

    touched.add(event.mint);
    input.counters.lastMint = event.mint;
    applied++;
  }

  for (const mint of touched) {
    recomputeIndicators(mint, Date.now(), db);
  }

  input.counters.lastSignature = input.signature;
  input.counters.lastEventAtMs = Date.now();

  return { applied, duplicate: false };
}
