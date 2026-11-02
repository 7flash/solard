# RPC management: operational acceptance

`slrd rpc add http https://provider.example/?api-key=... --group provider-plan --rps 5 --concurrency 2`
`slrd rpc add ws wss://stream.example/`
`slrd rpc list`
`slrd rpc test`
`slrd rpc status`
`slrd rpc auto on`
`slrd wallets --addresses-only`
`slrd wallets`

The RPC configuration is stored separately from signing wallets at `~/.solard/rpc.json`, or `SLRD_RPC_CONFIG_PATH`.
Do not publish this file: it contains full RPC URLs. CLI output removes opaque paths and query parameters.
The settings order is `--rpc-url`, `RPC_ENDPOINT`, `SLRD_RPC_URLS`, and saved HTTP URLs.
The first healthy provider becomes sticky; quotas marked exhausted cool down.
A successful `getSlot` is insufficient. HTTP readiness requires mainnet genesis and real balance/account reads;
WebSocket readiness requires a JSON-RPC subscription acknowledgement, not just a TCP handshake.

`SLRD_RPC_PROVIDER_LIMITS` maps canonical endpoint SHA-256 identities to `{group,rps,concurrency}`.
CLI configuration generates these identities without printing credentials. Legacy hostname keys remain supported.
Set the *same* group for keys sharing one provider quota. Different groups can add capacity.
`SLRD_RPC_AGGREGATE_RPS` is optional; absent it there is no extra global five-request bottleneck
for pooled requests. Other legacy direct calls still use the historical SharedRpcWindow limit.
`SLRD_RPC_GATE_DB` opt-in enables SQLite-backed quota-window reservations across processes
on the same filesystem; concurrent in-flight and queue admission remain process-local.
It does **not** provide a distributed cross-host or shared concurrency guarantee.
`SLRD_RPC_QUEUE_TIMEOUT_MS` bounds wait for a queued RPC. The queue limits waiting calls to 512
per quota group per process. Retry-After and exponential cooldown apply to quota failures.

Wallet native-SOL listing uses `getMultipleAccountsInfo`. A failed batch is marked unavailable,
not zero, and totals are reported as partial. Token holdings need separate token-account reads.
Do not move wallets to an empty group based on unavailable balances.

Derived WSS follows the newly selected HTTP endpoint. When independent `SLRD_WS_URLS` are set,
WebSockets can switch separately. Every stream switch emits `feed-gap-unverified`; trading
callbacks are blocked after such a gap until `verifyAndResume` validates fresh mint/pool state.
The recovery API is available on both `listenTrades` and raw subscriptions, including single-endpoint streams.
The verifier must return true only after validating every watched token; false, cancellation, timeout,
watchlist changes, and close keep delivery blocked. The 1–30000 ms deadline includes queue time.
`feedVerified` also becomes false after 60 seconds without an accepted trade. Recovery preserves
duplicate suppression and does not claim to backfill missing history. See [R9 recovery](rpc-r9.md).

Transaction submission is NOT automatically retried after an ambiguous network failure.
Reconcile signature status with existing Solard transaction safeguards. No trade signing,
broadcast, ALT creation, history rebuild, or production operation is required to test R8.

Run in the real worktree, after review:

```sh
bun test packages/cli/src/rpc-management.test.ts packages/core/src/chain/rpc-scheduler.test.ts packages/core/src/chain/rpc-pool-r8.test.ts
bun test packages/core/src/chain/connection.test.ts packages/core/src/chain/shared-rpc-window.test.ts
bun test packages/sdk/src/live.test.ts
npm test
bun run typecheck
```

R8 integration verification: 370 tests pass with 1,485 assertions across 103 files.
Core/SDK typechecks retain existing baseline failures, with no new normalized diagnostics.
CLI add/status/test was exercised against a local mock RPC without wallet access.
R8 has not been executed against real RPCs or production WebSocket subscriptions.

R9 extends admission to choose spare independent quota-group capacity, with FIFO bounded queues
and cancellation. Signed submissions retain single-attempt ambiguity handling.
