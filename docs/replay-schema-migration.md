# Replay schema migration and cleanup

Replay item event/effect/payout fields and coverage completeness/context fields belong to their Zod schemas. Runtime maintenance no longer appends undeclared columns. The pre-open transactional migration derives the exact DDL from the installed ORM, copies declared values and IDs, preserves current indexes/triggers, and retains the original table. It refuses unexpected undeclared columns. This also protects installations on ORM3.33, which otherwise creates empty replacements instead of copying rows.

The populated legacy regression runs a full migration followed by two unchanged opens. It checks attribution, coverage, original IDs, trigger/index operation and absence of new replay `_vN` tables on unchanged starts. Local verification uses installed ORM3.33; a live FairFun3.34 database was not opened or changed.

One-time cleanup is separate from startup:

```powershell
bun run scripts/cleanup-replay-backups.ts
bun run scripts/cleanup-replay-backups.ts --apply
# Explicit database for an isolated fixture or reviewed installation:
bun run scripts/cleanup-replay-backups.ts --db C:/path/to/db.sqlite
```

Only exact replay backup names ending `_v` plus digits qualify. Every target must be empty and unreferenced by current schema objects. The writer saves exact DDL and zero-row evidence before dropping eligible tables in one transaction. Populated, referenced, unrelated and active tables remain intact. A production run removed 2749 empty backups and retained one populated backup; evidence is in `.docs/recovery/replay-cleanup-1792901899219/`. No attempt was made to merge historical rows automatically.

Tests: `bun test packages/core/src/db/replay-schema-reopen.test.ts`; full `npm test`. An isolated cleanup fixture also proves populated/referenced/unrelated tables survive while the eligible empty backup is removed.
