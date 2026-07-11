# Standalone Solard Indexer

This folder is intentionally independent from `src/`.

It does **not** import:

```txt
src/*
../src/*
```

The worker entrypoint is now only a compatibility shim:

```txt
workers/helius-logs-worker.ts -> indexer/main.ts
```

Run:

```bash
bun indexer/main.ts
```

Existing process managers can keep running:

```bash
bun workers/helius-logs-worker.ts
```

Important env:

```bash
HELIUS_API_KEY=...
SOWL_DB_PATH=./sowl.db
SOLARD_SOL_USD=150 # optional; needed for USD market cap
```

The indexer writes:

- `terminalTokensLive`
- `terminalTradesLive`
- `terminalIndicatorsLive`
- `terminalProcessStatus`
- `terminalWorkerErrors`
- `terminalIngestionKeys`
