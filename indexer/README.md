# Standalone Solard Indexer

This folder is intentionally independent from `src/`.

It does **not** import:

```txt
src/*
../src/*


Database ownership lives in `shared/db.ts`. All tables are declared through sqlite-zod-orm schemas; indexer code must not issue raw SQL or manage schema compatibility itself.
