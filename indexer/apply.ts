import type { Database } from "bun:sqlite";
import {
  insertTradeAndToken,
  recomputeIndicators,
  rememberIngestionKey,
  upsertComplete,
  upsertCreate,
  withWrite,
} from "./db.js";
import type { Counters, IndexedEvent } from "./types.js";
export function applyIndexedEvents(
  db: Database,
  events: IndexedEvent[],
  args: { signature: string; supplyUi: number; counters: Counters },
): { applied: number; duplicate: boolean } {
  if (!events.length) {
    args.counters.skipped++;
    return { applied: 0, duplicate: false };
  }
  return withWrite(db, () => {
    const fresh = rememberIngestionKey(
      db,
      `helius-indexer:${args.signature}`,
      "helius-indexer",
    );
    if (!fresh) {
      args.counters.duplicates++;
      return { applied: 0, duplicate: true };
    }
    let applied = 0;
    const touched = new Set<string>();
    for (const event of events) {
      if (event.kind === "create") {
        upsertCreate(db, event, args.supplyUi);
        args.counters.creates++;
        touched.add(event.mint);
        args.counters.lastMint = event.mint;
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
    return { applied, duplicate: false };
  });
}
