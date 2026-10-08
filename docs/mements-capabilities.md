# Mements capability handoff — 2026-10-07

The registry has 0.2.31; the additional exact-sell, economic-sell and live-history changes below are being prepared for 0.2.32. No dependency source patches or new external dependencies were added. Funded mainnet launches, claims and migration acceptance have not been run.

## Exact position sells and live history (0.2.32)

```ts
const plan = await core.tx(wallet)
  .priorityFee({ cuLimit: 200_000, microLamports: 20_000 })
  .sell(mint, { amountRaw: positionTokensRaw, slippageBps: 500 })
  .build();
// SDK convenience form:
const result = await slrd.sell({
  token: mint, wallet, amountRaw: positionTokensRaw,
  slippageBps: 500, minOutputLamports: strategyMinimum,
}, { intentKey: "position:SELL:42" });
```

`amountRaw` is a positive bigint or integer string in raw token units. It is mutually exclusive with an explicit BPS size. It preserves the exact quantity instead of rounding a fraction of the whole wallet balance. Account closure is allowed only when that quantity is the entire current token-account balance. Submitted sells must have expected final SOL output greater than their selected network fee plus tip; otherwise they fail before broadcast with `UNECONOMIC_SELL`. This check does not predict net profit after rent, token transfer fees or subsequent price movement. For strategy targets, continue using `minOutputLamports`.

Configured `slrd.listenTrades({ tokens: [mint] })` inherits the client's RPC endpoints and database path. It records verified live events and sparse one-second candles by default, flushes buffered rows when closed, and accepts `history: false` to disable recording. Standalone `listenTrades` accepts an explicit `dbPath`. Collection starts with the subscription; existing empty history tables are not automatically historical backfills. Duplicate event indices are deduplicated, distinct legs are retained, and prices with unavailable quote conversion remain null. Collected history retains its commitment and is partial, with reserve spot prices rather than wallet fill prices. Use historical backfill for gaps and inspect coverage before backtesting.

The 0.2.31 type migration is documented in CHANGELOG.md: convenience trade statuses are `confirmed`/`failed`/`unresolved`, `.message` replaces `.error`, and listener adapters implement `onMigration`. An unresolved result must be reconciled before another trade.

The low-latency feed defaults to processed commitment. Backtests must explicitly opt into processed observations (`includeProcessed: true`) to use that collected tail, or use a confirmed/finalized subscription or backfill. A processed observation can be rolled back. An abrupt process kill can lose the current unflushed batch; `flushIntervalMs` controls that collection window.

## Creator fees

```ts
import { createSolard } from "@solard/sdk";
const slrd = createSolard({ rpcUrl, dbPath });
const discovery = await slrd.getClaimableCreatorFees(wallet, { tokens: [mint] });
// Read discovery.items and discovery.groups. This call never requests a signer.
const claims = await slrd.claimAllCreatorFees(wallet, {
  tokens: [mint],
  landing: { route: "helius-swqos", microLamports: 20_000 },
  computeUnits: "auto",
});
```

Discovery examines the specified coins, or all coins registered in this Solard database. It does not discover every coin ever launched by the wallet. Amounts are raw bigint values, with quote mint and decimals. Shared creator vaults are grouped once and list related mints; do not display their full amount on each coin or sum them twice. `unsupported` and `error` are different from an empty balance.

Sources: Pump curve and PumpSwap creator vaults (including closed curves), LaunchLab creator vaults and migrated CPMM creator-fee counters, Meteora DBC creator fees, and DAMM v2 creator-owned positions whose position NFT is owned by the wallet. Delegated/escrow positions, DLMM, CLMM and legacy locked-LP fees remain unsupported. Some claims return WSOL or another SPL token rather than spendable native SOL.

Claims are bounded instruction batches through the shared trade landing/simulation path. Packet-size validation still applies; reduce `maxInstructions` for large batches. Each receipt includes the sources, trade result and confirmed wallet-ledger payout when RPC metadata is available. Payout is a transaction-level delta, not invented per-coin attribution. Stop and reconcile an unresolved result. Reusing an indexed batch intent after the claim set changes can conflict; reconcile the existing batch key before starting a new batch operation.

## LaunchLab

```ts
const deployment = await slrd.prepareTokenDeployment("launchlab", wallet, {
  name: "Example", symbol: "EX", uri: uploadedMetadataUri,
  platformConfig: "bonkfun", // or stonkfun, stonkfun-reward, stonkfun-community
  quoteAsset,               // verified configured quote mint/program/decimals
  creatorBuySol: { sol: "0.001" },
  slippageBps: 500,
});
// Instruction-only preparation. Review/simulate using core transaction tools.
// One-call execution when ready:
const launched = await slrd.deployToken("launchlab", wallet, args, {
  landing: { route: "helius-swqos", microLamports: 20_000 },
  computeUnits: "auto",
});
```

Supply an already uploaded metadata URI; no LaunchLab upload endpoint is invented. `launchConfig` and `platformConfig` may be explicit on-chain addresses. The named platform IDs were checked against official Raydium/Stonk sources; preparation reads on-chain config and fee settings. Platform restrictions still apply and simulation must succeed. Reward/community presets are not a promise that every optional platform mode is supported.

In 0.2.32, `slrd.getSupportedLaunchLabPairs("stonkfun")` returns verified quote mint/program/decimals and launch config identities. `launchParametersRequireValidation` means the platform has additional parameter constraints; selecting that quote is insufficient to prove a particular launch is allowed. Native LaunchLab curve buy/sell routing is registered before Jupiter. Graduated curves fall through to other venues, and unsupported token extensions fail explicitly. Native SOL trades use an isolated temporary WSOL account so they do not consume existing WSOL holdings.

`initialBuy` spends an explicit amount already denominated in the pool quote. `creatorBuySol` instead funds from SOL. For custom quotes, create → SOL-to-quote funding → new-token buy are instructions in one transaction, and the second swap consumes only the funding route's guaranteed output. Per-leg slippage is split conservatively. Existing unrelated quote holdings are not budgeted into the buy; surplus output may remain as quote tokens. A missing funding route or oversized transaction fails before submission. Suitable lookup tables may still be required.

`deployToken` uses the shared landing route and simulation, returns `receipt`, `result` and `costs`, and registers the token only after confirmation. Unknown confirmed metadata means null accounting fields. Costs separate the requested creator-buy budget, actual network fee/tip, token-account rent delta, wallet SOL delta and unclassified residual. It does not guess mint/pool rent from token-account rent alone. Launch `intentKey` is explicitly unsupported until prepared mint/deployment persistence is implemented.

## Migration and prices

`listenTrades(...).onMigration(callback)` emits old pool (null if never observed), new pool, signature and slot, refreshes identities, and keeps the watched mint set. Subscriptions are re-created on provider rotation. `slrd.resolveCurrentMarket(mint)` reads verified Pump/Raydium pool and mint identities; an aggregator route hint alone is not a pool.

Live prices: Pump curve, PumpSwap, LaunchLab, Raydium CPMM, Meteora DBC and DAMM v2. CPMM events require the mint-bearing event layout and a verified matching pool. Raydium AMM v4 live prices remain unsupported: vault balances alone omit OpenOrders/PnL. Current-market discovery does not yet include Meteora; the existing Meteora venue resolvers do. Direct core listener recovery and silently broken sockets remain follow-up work.

## Strategies and real-history backtesting

SDK/core export `normalizeValueBandPolicy`, `planValueBandDecision`, `valueBandThresholds`, policy/decision/runtime types, and target-weight helpers.

Persist `ValueBandRuntimeState`: lower-band armed/side state, cumulative confirmed buy/sell SOL principal and peak net capital deployed. Fees do not belong in those principal counters. Reconcile pending trades before applying another decision; a decision is not a confirmed fill.

`slrd.historicalTape(mint, { fromMs, toMs, ... })` populates the existing per-database history cache and returns observed trades plus completeness diagnostics. Repeated complete backfills reuse stored history. Pump/PumpSwap/Raydium history is covered; Meteora history and custom-quote conversion are not guaranteed. Missing RPC transactions, undecoded transactions or missing prices keep the tape partial. Do not treat an empty partial tape as proof of no trades.

`buildHistoricalCandles(tape.events, 1000 | 5000 | 60000)` produces sparse observed candles; missing periods and unknown volumes are not fabricated. `runHistoricalStrategy` fills at a later observed event after the configured delay, includes configurable venue/slippage/network/tip costs and returns trades, P&L and capital curve. `sweepHistoricalStrategies` runs separate strategy instances over a supplied parameter list. This models observed historical prices, not guaranteed liquidity or reconstructed order-book execution.

## Wallet ledger and maintenance

`slrd.walletLedger(wallet, { since, additionalHistoricalAddresses })` accepts an epoch-millisecond number, ISO timestamp or Date (`sinceMs` also works). It uses the raw transaction cache and scans the wallet plus current token accounts. It includes actual payer fees, known priority fee/tips, rent, transfers, trades/claims and every observed token delta including unregistered mints. Signed components plus `residual` equal the observed SOL delta. Unknown effects remain residual. Coverage is explicitly partial because undiscovered historical closed accounts cannot be proven absent; supply known old token-account addresses to improve it.

`slrd.closeEmptyTokenAccounts(wallet, { keepMints })` batches verified closes and returns confirmed reclaimed lamports or null when accounting is unavailable. `burnDust: { [mint]: maximumRawBigint }` explicitly permits burning only balances under that ceiling before closing. No implicit dust burns; nonempty WSOL requires unwrapping. An oversized batch can require a smaller `batchSize`.

SDK sell input / core composer sell supports `closeTokenAccount: true` only for a full-position sell. The close is atomic with the sell; the wallet must hold close authority and no withheld fees. Callers that share one mint across logical positions must leave this option off until every position is exiting.

`slrd.getSupportedPumpPairs()` returns verified quote mint programs/decimals plus metadata symbols when available. The Global decoder reads the exact fixed whitelist slot rather than trailing creator-fee/reward fields. `slrd.listVanityMints()` exposes public pool entries; `prepareTokenDeployment(..., { vanitySuffix })` reserves a pre-generated mint from this database and marks it used after confirmed launch. Generate inventory ahead of time with the existing vanity-pool CLI. Never manually release a reservation belonging to an unresolved submission.

## Remaining acceptance

Validation: 293 tests passed across 83 files; package manifests and core/SDK/CLI dry-run packaging passed. SDK runtime export smoke check passed. The pinned TypeScript diagnostic pass still reports existing missing Node types, dependency/configuration and unrelated source errors; the workspace typecheck is not green.

- Funded claims/launches and migration cycles, with a dedicated wallet and spending cap.
- Full per-coin payout attribution where the protocol exposes shared vault balances, and richer mint/pool rent accounting.
- Persisted launch intents/prepared mints and batch-claim restart ergonomics.
- Meteora historical tape/current-market discovery and live AMM v4 pricing.
- Publish core/SDK/CLI 0.2.30 after restoring npm authentication; installed 0.2.29 must not be treated as containing these APIs.
- Normal workspace typecheck remains blocked by TypeScript configuration and existing repository/dependency diagnostics.

Protocol references: [Pump Global IDL](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json), [Raydium LaunchLab creator fees](https://github.com/raydium-io/raydium-docs-v1/blob/main/products/launchlab/creator-fees.mdx), [Stonk platform configuration API](https://www.stonkfun.xyz/api/public/v1/launchlab/platforms).
