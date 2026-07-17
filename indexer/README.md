# Standalone Solard Indexer

The indexer imports only `indexer/*`, `shared/db.ts`, and `shared/measure.ts`.
It never imports the application `src/*` tree.

## Database ownership

`shared/db.ts` is the only module allowed to construct `sqlite-zod-orm`'s
`Database`. `shared/terminal-db.ts` and `shared/terminal-repo.ts` are deprecated
compatibility facades that re-export the canonical instance and create no
tables, views, or connections.

New installations default to `~/.solard/solard.sqlite`. If the legacy
`~/.sowl/sowl.sqlite` already exists and the renamed path does not, it is used
automatically to avoid silently starting with an empty database. Set
`SOLARD_DB_PATH` to make the location explicit.

## Bounded terminal storage

The main indexer runs a maintenance pass every hour by default. Terminal trades
are retained for seven days and inactive terminal tokens for fourteen days.
Wallet-observation and copy-trade audit tables are not pruned by this job.

Relevant overrides:

- `SOLARD_MAINTENANCE_INTERVAL_MS`
- `SOLARD_TRADE_RETENTION_MS`
- `SOLARD_TOKEN_RETENTION_MS`
- `SOLARD_WORKER_ERROR_RETENTION_MS`
- `SOLARD_SIGNAL_RETENTION_MS`
- `SOLARD_TERMINAL_FEED_MAX_CANDIDATES`

## Pump discovery state

PumpPortal discovery state is debounced instead of synchronously rewriting the
whole file for every create. Entries older than `SOLARD_PUMP_ACTIVE_WINDOW_MS`
are pruned. The flush interval is controlled by
`SOLARD_PUMP_DISCOVERY_FLUSH_MS`.
