# R9 RPC capacity and stream recovery

HTTP budgets are keyed by SHA-256 of canonical full endpoint URL. This distinguishes
multiple keys on one host without displaying the keys. Choose a common `group` when
endpoints share one actual account quota. The in-process scheduler shares that
group across pools; SQLite reservations remain opt-in and do not share concurrency.

Read operations choose an available independent group when the sticky provider
is saturated; signed submission remains single-attempt after transport ambiguity.

Both `listenTrades` and `subscribeTrades` return a subscription with `verifyAndResume(async ({connection,
tokens,signal}) => boolean)`. The application must query and validate fresh
current mint/pool state using the supplied connection and signal. Return `true`
only after validating every watched token. Recovery is bounded by 1–30000ms.
This resumes present-state callbacks; it does NOT restore missing event history.
`feedVerified` becomes false after the stream is stale.

Acceptance in the real worktree:

```sh
bun test packages/core/src/chain/rpc-pool-r8.test.ts packages/core/src/chain/rpc-scheduler.test.ts
bun test packages/sdk/src/live.test.ts packages/sdk/src/live-recovery.test.ts
npm test
bun run typecheck
git diff --check
```

No paid-provider probe, live trading, signing, broadcasting or database rewrite
is implied by these deterministic tests.
