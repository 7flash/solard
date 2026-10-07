# Project Tasks & Ideas

## Priority: Fix

- [x] ~~Mements capability API implementation~~ — ✅ DONE locally in 2c8c9ca. Grouped read-only creator fees and source builders, LaunchLab including atomic SOL funding, migration-aware SDK feed/CPMM identities, strategy/backtest exports, exact observed wallet ledger, guarded maintenance/full-sell closure, whitelist decoder and scoped vanity inventory. 293 tests pass; all package dry-runs and manifest checks pass. Coverage limits in docs/mements-capabilities.md.
- [ ] Complete funded creator-fee/LaunchLab/migration acceptance with dedicated wallet and explicit budget; no mainnet operations performed.
- [ ] Persist prepared launch mint/intents and improve batch-claim restart identity; deployToken explicitly rejects launch intentKey today.
- [ ] Add Meteora history/current-market resolution, live Raydium AMM v4 prices, and richer mint/pool rent accounting; shared creator vault amounts cannot be attributed per coin from balances alone.

- [x] ~~Fast landing F/G implementation~~ — ✅ DONE locally in e2a2530. Explicit Helius tiers/tips, simulation sizing, low bids and price guards, identical-byte restart rebroadcast, batching/reserve snapshots, HTTP/SDK trade-feed failover, optional cross-process sliding window. 251 tests pass; release manifests and all three package dry-runs verified. Mainnet landing measurements/funded acceptance remain unverified.
- [ ] Complete fast-landing funded acceptance and publish before Mements removes its execution layer; see FAST-LANDING-HANDOFF.md for API and limits.
- [ ] Launch/migration feeds only fail over at startup; direct core listeners and silently broken sockets still need connection recovery.

- [x] ~~Transfer fee/landing visibility~~ — DONE. Transfer now uses automatic fees and safe bounded settlement; selected and actual fees are distinct in output, expiry metadata is persisted. 208 tests pass. User's original signature has no public mainnet status/history; no replacement sent and root cause not proven.
- [ ] Reconcile original 2 SOL transfer using its actual execution journal/RPC cluster before considering another transfer; absent from the default DB examined.

- [x] ~~0.2.30 guarded programmatic routes~~ — DONE. Jupiter plans, pre-sign size/minimum checks, intents/reconciliation, balance/rent checks, fee caps, wallet helpers, enum migration regression and busy timeout implemented.
- [ ] Publish and registry-verify @solard/core/sdk/cli 0.2.30 — manifests and all package dry-runs verified; latest publish rejected with E404 and npm whoami returns E401 (authentication invalid). Registry latest remains 0.2.29 for all three. Fresh web login initiated; publish core, SDK, CLI in order after authentication, then push.
- [ ] Funded cycle/crash test: awaiting dedicated wallet and spending cap; unsigned AMM/CPMM buy and 10% sell cycles pass.
- [ ] Verify routable LaunchLab example; recent public examples have no Jupiter route.
- [x] ~~Live Raydium CPMM pool prices~~ — ✅ DONE locally with mint-bearing event layout, matching on-chain pool/program/mint identity and verified supply; multi-pool regression passes. AMM v4 remains open above.
- [ ] Reconciliation for an intent reserved without a signed generation requires explicit manual recovery; no automatic replacement.
- [ ] Cross-process wallet ordering for different intent keys and whole exit flows remains caller-owned.
- [x] ~~0.2.30 regression checks~~ — DONE. Implementation committed. 205 tests pass; read-only Raydium AMM (51,504 CU buy / 87,453 CU combined) and CPMM (61,706 CU buy / 107,554 CU combined) simulations succeed. Full repository typecheck still has pre-existing configuration/dependency/source diagnostics.

- [x] ~~Identify MEMAI AccountNotFound~~ — ✅ DONE. Read-only mainnet lookup of the provided token ATA showed the exact reported raw balance and owner 4jxDfXDLRh3fJvQxPhuV5uMt4YLEsaM6QNYFuMddbCen; owner SOL account was absent at slot 453577000. Simulation now reports actual compiled fee-payer existence/balance separately from raw logs. No transactions sent.
- [ ] Re-simulate MEMAI sale after owner funds its SOL fee-payer account — verify account creation/rent and fees before execution.

- [ ] Validate named custom PumpSwap pairs with live read-only construction/simulation — provide concrete pool addresses and verify extension handling, intermediate residuals and transaction-size limits before a funded cycle.
- [ ] Implement Meteora DBC venue discovery/decoding/execution separately — neither supplied patch includes this pool type.
- [x] ~~Apply custom-pair routing patch~~ — ✅ DONE. Applied the atomic routing patch and selected combined-patch identity/metadata corrections; custom fees retained. 39 distinct affected regressions passed across the suite and added refresh check; no live transactions sent.

- [ ] Fix core TypeScript configuration compatibility — installed tsc rejects removed baseUrl and non-relative paths before checking source files.
- [ ] Resolve execution-token test mismatch — auto-inspection returns decimals as string "6", while the existing test expects numeric 6.
- [x] ~~Custom direct trade fees~~ — ✅ DONE. Core buy/sell and buyMany/sellMany plus SDK buy/sell execution options forward priorityFee. Six focused tests pass; core README explains receipt states.

- [x] ~~WebSocket probe close race~~ — DONE. Successful readiness settles before closing the probe; regression covers synchronous normal close and premature close.
- [ ] Repair workspace test command — `npm test` currently reports no packages matched the filter.
- [ ] Resolve repository typecheck failures — root tsc reports existing errors across dependencies, core, CLI, and browser wallet modules.

## Validation

- Custom routing: affected market/tx/Pump/SDK/migration/core-fee suite passed 38 tests; the final new refresh test and its four neighboring custom-pool tests also passed (39 distinct tests total).
- TS 5.8 fallback reaches source checking but remains blocked by repository dependency/Node type resolution and unrelated existing source diagnostics; default compiler rejects baseUrl before source checking.

- `bun test packages/core/src/core/solard.trade-fees.test.ts packages/sdk/src/client.trade-fees.test.ts`: 6 passed; mocks prevent transaction submission.
- Neighboring execution-token tests: 4 passed, 1 existing decimals-type mismatch failed.
- `bunx tsc --noEmit -p packages/core/tsconfig.json`: blocked at configuration parsing (TS5090, TS5102).

- `bun test packages/sdk/src/live.test.ts`: 3 passed.
- `npm test`: blocked by workspace filter configuration.
- `npx tsc --noEmit -p tsconfig.json`: existing repository failures; test fetch mock cast adjusted after checking diagnostics.

## Architecture Notes

- [x] Shared ordinary-trade landing policy: native CLI fee flags, core/SDK dynamic pricing, bounded expiry-safe replacement, and attempt reporting. 60 relevant tests pass; no live trades sent. Bundle/group builder and Jupiter policies remain separate.

- Live readiness probes are in `packages/sdk/src/live.ts`; they derive WebSocket access from RPC_ENDPOINT.

## Security Reminders

- Keep provider API credentials out of diagnostics; regression uses fake credentials and mocked network APIs.

## Handoff fixes — current status (2026-10-06)

- [x] PumpSwap pool identity filtering, actual quote decimals/programs and chain supply; multi-pool strategy regression.
- [x] Pillson/Nut atomic SOL-funded buys pass unsigned mainnet simulation with suitable public lookup tables.
- [x] DBC and DAMM v2 discovery/execution/events; THICC migrated DAMM v2 buy passes unsigned mainnet simulation.
- [x] Confirmed SOL principal/network fee/target delta accounting and pre-submission phase regressions.
- [x] Additive SQLite migration helper and ORM reopen regression preserve rows/triggers; unsafe default schema sync documented.
- [x] Numeric token read mismatch and workspace test command repaired. `npm test`: 195 pass, zero fail.
- [ ] Funded confirmed buy/sell cycle, pending wallet/cluster/budget and reviewed transaction approval.
- [ ] Repository-wide typecheck cleanup remains outstanding.

Earlier unsupported DBC/test-runner/decimal notes describe the prior patch stage
and are superseded by this status. See [handoff acceptance](HANDOFF-ACCEPTANCE.md).
