import type { SowlDatabase } from "./schema.js";

type RawDb = {
  exec?: (sql: string, params?: unknown[]) => unknown;
  run?: (sql: string, params?: unknown[]) => unknown;
  pragma?: (sql: string) => unknown;
};

function raw(db: SowlDatabase): RawDb {
  return db as unknown as RawDb;
}

function exec(db: SowlDatabase, sql: string): void {
  const r = raw(db);
  if (typeof r.exec === "function") {
    r.exec(sql);
    return;
  }
  if (typeof r.run === "function") {
    for (const statement of sql
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)) {
      r.run(statement);
    }
  }
}

export function ensureSolardDatabaseRuntimeObjects(db: SowlDatabase): void {
  const r = raw(db);
  try {
    if (typeof r.pragma === "function") {
      r.pragma("journal_mode = WAL");
      r.pragma("synchronous = NORMAL");
    }
  } catch {
    // PRAGMA support varies across sqlite-zod-orm runtimes; indexes below are the critical path.
  }

  exec(
    db,
    `
    create index if not exists idx_pump_sma_lookup
      on pumpPriceAggregates (mint, intervalSeconds, bucketStartMs desc);
    create index if not exists idx_pump_sma_recent
      on pumpPriceAggregates (intervalSeconds, bucketStartMs desc, mint);
    create index if not exists idx_pump_sma_updated
      on pumpPriceAggregates (updatedAtMs desc, mint, intervalSeconds);
    create index if not exists idx_pump_events_recent
      on pumpTokenEvents (updatedAtMs desc, mint);
    create index if not exists idx_pump_swaps_mint_recent
      on pumpSwaps (mint, createdAtMs desc);
    create index if not exists idx_pump_holders_mint_balance
      on pumpHoldersCurrent (mint, balanceUi desc, lastUpdatedMs desc);
    create view if not exists pumpLatestSma as
      select p.*
      from pumpPriceAggregates p
      where not exists (
        select 1
        from pumpPriceAggregates newer
        where newer.mint = p.mint
          and newer.intervalSeconds = p.intervalSeconds
          and newer.bucketStartMs > p.bucketStartMs
      );
    `,
  );

  try {
    exec(
      db,
      `
      create virtual table if not exists pumpTokenSearch using fts5(
        mint unindexed,
        name,
        symbol,
        creator,
        content='pumpTokenEvents',
        content_rowid='id'
      );
      `,
    );
  } catch {
    // FTS5 is optional in some bundled SQLite builds. Normal indexed reads remain supported.
  }
}
