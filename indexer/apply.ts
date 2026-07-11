import type { TerminalDatabase } from "../shared/terminal-db.js";
import {
  insertTradeAndToken,
  recomputeIndicators,
  rememberIngestionKey,
  upsertComplete,
  upsertCreate,
  withWrite,
} from "./db.js";
import { enqueueMetadata } from "./metadata.js";
import type { Counters, IndexedEvent } from "./types.js";
import type { IndexerConfig } from "./config.js";

export function applyIndexedEvents(
  db: TerminalDatabase,
  events: IndexedEvent[],
  args: {
    signature: string;
    supplyUi: number;
    config: IndexerConfig;
    counters: Counters;
  },
): { applied: number; duplicate: boolean } {
  if (!events.length) {
    args.counters.skipped++;
    return { applied: 0, duplicate: false };
  }

  const result = withWrite(db, () => {
    const key = `helius-indexer:${args.signature}`;
    const fresh = rememberIngestionKey(db, key, "helius-indexer");
    if (!fresh) {
      args.counters.duplicates++;
      return {
        applied: 0,
        duplicate: true,
        metadata: [] as Extract<IndexedEvent, { kind: "create" }>[],
      };
    }

    let applied = 0;
    const touched = new Set<string>();
    const metadata: Extract<IndexedEvent, { kind: "create" }>[] = [];

    for (const event of events) {
      if (event.kind === "create") {
        upsertCreate(db, event, args.supplyUi);
        args.counters.creates++;
        touched.add(event.mint);
        args.counters.lastMint = event.mint;
        metadata.push(event);
        applied++;
      } else if (event.kind === "trade") {
        insertTradeAndToken(db, event, args.supplyUi);
        args.counters.trades++;
        touched.add(event.mint);
        args.counters.lastMint = event.mint;
        args.counters.lastMcapUsd =
          event.marketCapUsd ?? args.counters.lastMcapUsd;
        applied++;
      } else if (event.kind === "complete") {
        upsertComplete(db, event);
        args.counters.completes++;
        touched.add(event.mint);
        args.counters.lastMint = event.mint;
        applied++;
      }
    }

    for (const mint of touched) recomputeIndicators(db, mint);

    args.counters.lastSignature = args.signature;
    args.counters.lastEventAtMs = Date.now();

    return { applied, duplicate: false, metadata };
  });

  for (const create of result.metadata) {
    enqueueMetadata(
      { db, config: args.config, counters: args.counters },
      {
        mint: create.mint,
        uri: create.uri ?? "",
        name: create.name,
        symbol: create.symbol,
      },
    );
  }

  return { applied: result.applied, duplicate: result.duplicate };
}
