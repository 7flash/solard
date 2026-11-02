# Changelog

## Unreleased

- Add read-only last-day wallet-presence ranking with frozen pre-launch model
  provenance, history shrinkage, capped wallet contributions, per-wallet evidence,
  15/60s transfer audits and bounded current-market screening. Keep live model and
  trading policy unchanged; unknown history is not a negative label or holding.

- Fix the read-only scout's enrichment connection bypassing Solard pacing and
  sticky RPC fallback. Preserve quote identity, conversion and score guards. Add
  a bounded recent-launch indexer review with coverage and response receipts;
  ranked activity remains unverified candidate evidence, not trade authorization.

- Add read-only launch-family analysis for IRONY/IRONYMAN and ALON, with configurable
  aliases, distinct-mint counts, fixed-window and sensitivity outcomes, early-flow
  comparisons, missing-history exclusions and hashed source/indexer snapshots.
  This does not change live selection rules or trading controls.

- Add the scout terminal with conflict-checked manual range editing, saved positions,
  source ages and trade events. Host existing two-sided allocation strategies in the
  range manager's shared SDK/wallet queue; preserve allocation budgets and journals.
  Share blockhash warming and pace manager RPC reads. No claim of sub-second landing.

- Add program-reported `trader` and `creator` to Pump and PumpSwap `TradeEvent`s. Fix SQD subscriptions closing once more than 10 addresses were watched: Portal caps each instruction filter at 10 values, so watched addresses are now split across filters.

- Default Node/core live trade, launch, migration and typed token subscriptions to SQD, with `source: "rpc"` selecting the existing WebSocket implementation. Share protocol decoders and verified market pricing; preserve actual finality, original log indices, history deduplication and transfer provenance. Add cancellable Portal streaming, dynamic watch filters, throttling/fork status and `sdk.events.subscribeToken`. See `docs/event-sources.md` for RPC enrichment and restart limitations.

- Keep quiet SQD tokens live using fresh block progress; preserve RPC recovery gates. Use original block timestamps for venues without program-event timestamps so historical replay cannot appear fresh. Honor Retry-After for Portal head reads too, and isolate callback failures without replaying successful callbacks from the same block.

- Fix one-shot CLI processes remaining alive after confirmed sends when the primary signature WebSocket rejects with 429. Dispose owned HTTP/WebSocket resources on close, cancel reconnect/heartbeat timers, and print PERF during command cleanup. Add local mock-RPC subprocess regressions for natural exit without forced process termination.

- Add reversible ignored-wallet selection using the existing active flag, without schema changes. Exclude ignored wallets from default lists, automatic group selection and registry RPC scans; add `wallet ignore/unignore`, listing overrides and batched `wallets --ignore-zero`. Retain encrypted keys, history and group memberships.

- Fix RPC sliding-window admission timestamps that preceded actual transport dispatch. Hold unstarted slots until dispatch, use monotonic deadlines and retain rate slots conservatively after synchronous observer/transport delays. Add a deterministic observer-delay regression without relaxing the four-RPS assertion.

- Prepare Luffy/STRAWHAT with an eight-wallet3.5SOL budget, metadata/vanity reservation, authoritative simulated acquisition amounts and one grouped protected exit. Add a durable prepared-launch/exit controller that observes landing independently of slow submission acknowledgements, preserves signed originals and requires expiry/failure proof before replacement. Preparation defaults to unsigned simulation; no funded operation was performed.

- Add shared HTTP RPC pacing through `rpc: {maxRps, maxConcurrent, retryOn429}` or a reusable `createRpcPacer` instance, plus injectable fetch. Route Node SDK live readiness/enrichment and raw history through controlled transports. Pause endpoint queues on 429, support cancellation and preserve signed-send guards and physical-attempt telemetry. WebSocket reconnect backoff remains separate.

- Add a resumable local 100-mint `pump` batch job with encrypted pool persistence and public-only checkpoints, plus a read-only finalized FAIRS exit/P&L audit.

- Wire FAIRS operational scripts into the existing SDK RPC endpoint pool, including both configured Helius keys and public mainnet fallback. Test quota-driven read rotation and sticky recovery; preserve signed-submission uncertainty guards.

- Add explicit grouped Pump Jito followers (`--buyers-per-transaction 1..3`), preserving per-wallet minima and co-signatures. Simulate complete dependent bundles in dry runs, optimize compute, and simulate again; pin blockhash lifetimes and preserve the final tip payer on retries. Return a wallet-to-transaction receipt map. Allow explicit exact-owner vanity reservation resumption without releasing it during review.

- Fix repeated replay-table rebuilds caused by runtime-only columns. Declare event/effect/payout and coverage metadata in the schemas, remove redundant ALTERs, and migrate legacy layouts transactionally before ORM synchronization. Preserve row IDs, field values, indexes, triggers and original backup tables; test populated migration and two unchanged reopens.

- Add hot-reloaded allocation controls, finalized external inventory reconciliation, live market-cap markers and UI position creation. Add SDK RPC observers with sanitized context/timings, bounded background persistence and an active/slow request page. Preserve pending financial submissions.

- Add range allocation bid/ask mode, shared selected-runner wallet execution and explicit SOL-quoted Raydium AMM v4 exact-input trading. Range steps represent a fraction of range width. Preserve per-token journals and original pending submissions. Reject unverified completed-curve pool guesses and validate Raydium pool/vault/mint identity before quoting or building.

- Range targets now represent pre-trade spot prices. Prepare impact/fee-aware output floors at the trigger boundary using conservative constant-product reserve projections and official PumpSwap fee math, including virtual quote reserves. Preserve custom-quote atomic legs and guaranteed intermediate spending. Additional slippage scales with range width (10% of positive relative spread by default) and is hard-capped at 200bps; expose `--range-slippage-share-bps` and SDK `priceKind: "spot"`/`additionalSlippageBps`. Existing average-price SDK orders retain their guards.

- Add SDK/core `prepareFastTrade` with single-use prepared Pump/PumpSwap limit orders, protected custom-quote legs, background blockhash/template refresh and five-second exact-byte balance/fee leases. Range triggers skip simulation and RPC preflight, persist recovery data before sending, and log submission separately from settlement. Route/price/size changes invalidate readiness; pending outcomes still prevent replacement trades.
- Add range `--hold-ms` (default 0; 2000 requires fresh qualifying samples spanning two seconds), configurable fixed CU price/limit (20,000 micro-lamports, 600,000 CU defaults) and one-second default sampling. Recrosses and stale/failed samples reset the hold. No live subsecond landing guarantee.

- Add a read-only live SMA CSV reporter with one latest row per token/wallet, verified-supply USD market-cap targets, effective profit-constrained sell floors, freshness status and atomic output updates. Trading bots do not need restarting.

- Fix SDK price-only sells: replace the unintended default 15% haircut with an on-chain SOL minimum derived from the stricter of minPriceSol and minOutputLamports. Preserve explicit-slippage behavior and protected intermediate legs.

- Count RPC work toward SMA tick cadence so 5-second intervals can meet existing sample-density checks instead of stalling at47 samples.

- Reuse explicitly registered, on-chain-verified quote pools for SMA SOL conversion. Explicit PumpSwap registration skips unrelated venue discovery while retaining pool/mint/vault verification, supporting public providers that reject indexed queries.

- Limit PumpSwap discovery account batches to10 for public RPC compatibility; regression mock rejects larger batches. This avoids PublicNode HTTP403/-32602 failures unrelated to request volume.

- SMA bot samples custom-quote markets through verified fresh quote/SOL conversion and blocks unavailable conversion rather than rejecting all non-SOL pairs.

- SMA trade.ts supports a per-process `--rpc-url` override and registers unknown mints before entering its price loop.

- Derive an on-chain token minimum for SDK price-only buys, avoiding unintended default 15% slippage guard rejection; retain explicit percentage-slippage behavior. Expand SMA trade.ts result diagnostics to show the actual code/message/phase and submission count.

- CLI native buys accept `--max-price-sol` (SOL per whole token), derive a ceiling-rounded on-chain token minimum with integer arithmetic, and preserve the existing worst-case price guard. Enforce the stricter floor when combined with `--min-out`; reject percentage-slippage combinations.

- Fix CLI auto-routing of uncached or unknown Pump tokens: discover/refresh native metadata before selecting Jupiter. Keep explicit Jupiter routing and genuine non-native fallback; propagate provider failures.

- CLI buy/sell accept mutually exclusive `--min-out` (human target tokens / SOL) and `--min-out-raw` as alternatives to percentage slippage on native Pump/PumpSwap routes. Preserve absolute instruction minima across PumpSwap refresh and final custom-quote conversion; reject adverse quotes before signing. Jupiter explicitly rejects unsupported absolute floors.

- Generate and package core/SDK declarations with conditional type exports and an archive-based strict consumer check. Include generated sqlite-zod-orm declarations to avoid checking its older measure-fn implementation; preserve runtime dependency versions. Disambiguate launch metadata as `PumpLaunchTokenMetadata`, restore agent config/state merge methods and Meteora wallet balance helpers, and align transaction assembly error handling with the measurement API. Consumer validation uses skipLibCheck for upstream declaration defects. No funded acceptance or publication is claimed.

- Add persistent RPC CLI configuration and account-read diagnostics, provider quota windows and bounded queues, unavailable wallet-balance reporting, and independent WebSocket endpoints. Split batches before provider admission and preserve derived-WSS routing on HTTP failover. Reads use spare independent quota-group capacity; canonical endpoint identities distinguish same-host plans. Stream gaps fail closed until bounded caller verification through `verifyAndResume`; `feedVerified` reports current eligibility without claiming missing history. Readiness probes share provider budgets.

- Pin Pump SDK 4.1.0 for custom-quote creation eligibility and protocol reserve initialization, including QuoteControl. Add public-payer unsigned launch/sell preparation and simulation, protected atomic creator buys, and funding-route ALT discovery. Preserve provider failures during current-market discovery. No funded execution or live acceptance is claimed.

- Try canonical PumpSwap candidates before bounded transaction history, inspect noncanonical candidates incrementally, and retain verified pool identities for five minutes. Report RPC provider failures separately from absent routes and run unsigned-buy acceptance independently of the live feed.
- Candidate noncanonical PumpSwap mint-activity discovery, native conversion, read-only unsigned buy simulation, and verified existing ALT selection. Pending local mainnet acceptance; no funded execution.

## 0.2.34 — 2026-10-09

- Validate parsed RPC version-1 responses with the complete response-body validator while preserving their actual version; the captured SEEDCAT response covers web3.js 1.98.4.
- Resolve Pump quote identity and decimals from verified curve/mint accounts without parsed transaction enrichment. Convert eligible quote curves and PumpSwap pools through bounded verified reserves, with explicit unsupported metadata, migration-gap and missing-conversion reasons.
- Pack and install matching release archives in a fresh Bun project; verify SDK/core runtime exports and installed SDK live/readiness tests before publishing.
- Export `createTraderSolard` from the SDK as the core trader factory. The configured application facade remains `createSolard`.
- Declare core's direct `measure-fn` 5.3.1 runtime dependency; isolated installation exposed missing serialization exports through the previous accidental transitive dependency.
- Synchronize all release manifests and internal dependency pins. No funded mainnet acceptance is claimed.

- Bound executable custom-quote funding/exit chains to four venues with cycle rejection and observable per-leg guaranteed minima; support quote coins still on curves and listed non-SOL quote conversion through registered venues. Preserve aggregate SOL guards and unrelated wallet holdings.
- Create custom-quote Pump curve buyback ATAs idempotently with the actual quote token program before buy/sell instructions.

## 0.2.32 — 2026-10-08

- Exact sells: composer/core accept `amountRaw: bigint | string`; SDK accepts `amountRaw` or `amount: { raw }`. Explicit `bps` and exact amounts are mutually exclusive. Exact raw units are validated against the wallet's token-account balance and preserved in plan metadata and intent fingerprints.
- Reject sells whose expected final SOL output cannot exceed the selected network fee plus landing tip before broadcasting (`UNECONOMIC_SELL`). When expected output is absent, use the guaranteed SOL minimum conservatively; unavailable output is `SELL_ECONOMICS_UNAVAILABLE`. Cost metadata describes a quote, never a fee paid.
- Configured SDK trade subscriptions persist verified live trades and sparse one-second candles by default, sharing the client's database/RPC configuration. Recording is lazy, bounded and flushes on listener close; `history: false` disables it. Event indices retain distinct transaction legs. Collected data is partial and keeps commitment and unavailable prices rather than claiming complete finalized history.
- `preparePumpTokenLaunch` supports an atomic SOL-funded creator buy for custom quotes, retaining all temporary-account signers and lookup-table metadata. Custom-quote follower bundles remain explicitly unsupported.
- Add a captured mainnet Pump Global account regression at slot 454573144: the whitelist slot is decoded independently of the following account fields.
- Register native instruction-only LaunchLab buy/sell routing before Jupiter, with verified pool/config/mint/vault identity, actual Token-2022 quote programs and isolated temporary WSOL accounts. Persist `raydium-launchlab` route hints. Graduated curves fall through to other routes.
- Expose `getSupportedLaunchLabPairs(platformConfig)` from configured clients, using on-chain configuration eligibility and explicit parameter-rule validation flags. Named presets remain available.
- Preserve Helius SWQOS URL routing in the Pump launch pipeline and validate tier-specific tips (5,000 lamports SWQOS, 1,000,000 Max).

### Type migration from 0.2.29/0.2.30 to 0.2.31

- `SolardTradeExecutionResult` is now `TradeResult`: statuses are `confirmed`, `failed`, `unresolved`. Replace checks for `submitted` with `unresolved`; an unresolved signature must be reconciled before another trade. There is no `expired` success/failure shortcut: expiry replacements require proof of absence.
- Replace receipt `.error` reads with `.message` and branch on `.code`/`.phase`. `networkFeeLamports`, SOL principal and token delta can be null until confirmed transaction metadata is available. A definitive on-chain failure can still charge a network fee.
- `TradeListener` now includes `onMigration(callback)`. Structural mocks/adapters must implement it and return an unsubscribe function; `TradeListenerMigration` includes nullable `oldPool` and `newPool`.
- Native/core transaction APIs return `SendReceipt` with `submitted` for uncertain broadcasting; convenience core/SDK buy/sell return `TradeResult` with `unresolved`. These are distinct public types; do not cast one to the other.

## 0.2.31 — 2026-10-08

- Expose read-only grouped creator-fee discovery and bounded claims for Pump/PumpSwap, LaunchLab/CPMM and eligible Meteora creator positions, with explicit unsupported/error coverage.
- Add the LaunchLab launchpad, named platform presets, atomic SOL-funded custom-quote creator buys, shared landing and confirmed cost fields.
- Add migration-aware SDK trade subscriptions, verified current-market discovery and mint-bearing CPMM price events. AMM v4 live prices remain unsupported.
- Export value-band/target-weight strategy helpers and cached historical tape, sparse candles, delayed-fill simulation and parameter sweeps.
- Add exact observed wallet ledger components with residual/partial-history reporting; batch empty-account maintenance, explicit dust burn and opt-in full-sell account closure.
- Scope pre-generated vanity inventory to the caller's database and decode Pump's exact whitelist slot rather than following fields.
- Funded acceptance, fuller launch/batch intent persistence and historical/live coverage gaps remain open; see docs/mements-capabilities.md.

## 0.2.30 — 2026-10-06

- Add explicit Helius SWQOS/Max landing tiers with pre-sign tips, low initial fee bids, configurable fee floors, and simulation-derived compute limits.
- Guard worst-case buy/sell SOL prices before signing; expose retryable definitive slippage and price rejection separately from unresolved submissions.
- Persist signed transaction bytes for restart rebroadcast and resend identical bytes through Sender and RPC while valid, retaining finalized expiry auditing.
- Batch PumpSwap/preflight reads, cache validated mint metadata and rent, accept recent pool reserve snapshots, and support stoppable blockhash warmup.
- Add sticky HTTP endpoint failover, trade-feed provider health rotation, and a sliding-window rate gate with optional cross-process SQLite coordination.

- Transfers now share automatic fee selection and expiry-safe landing rather
  than defaulting to zero priority and a one-shot confirmation wait. CLI results
  show selected compute/priority and estimated network fees separately from
  confirmed charges; unresolved transfers are never replaced blindly.
- Persist fee estimates, blockhash and expiry height in execution metadata.

- Include the closed Pump curve exception, standalone PumpSwap inspection,
  explicit pool routing and Meteora DBC/DAMM v2 venues from fe0dbda.
- Add instruction-only Jupiter fallback to composer buy/sell, with caller RPC
  submission, slippage, compute budgets, tracked accounts and route lookup tables.
- Reject transactions exceeding packet size and trades below requested output
  minima before signing. Atomic sells expose protected SOL `minOutputRaw`.
- Convenience trades return confirmed/failed/unresolved results. Persist optional
  intent keys and signatures before broadcasting; reconcile original signatures
  after restart without placing another trade.
- Add notional priority-fee caps, sender fallback using identical signed bytes,
  progress hooks, SOL/rent preflight and per-wallet convenience-operation ordering.
- Add route-independent all-token transfers, wallet exit reports, withdrawal
  estimates and public Pump curve reserve/liquidity fields.
- Set SQLite busy_timeout to five seconds. Regression verifies that the token
  venue enum extension preserves previous-schema rows, indexes and triggers.
- Unsigned mainnet Raydium AMM/CPMM buy and buy-then-10%-sell simulations pass.
  Funded/crash acceptance and a routable LaunchLab example remain unverified.
  Live pool prices cover Pump, PumpSwap, LaunchLab, DBC and DAMM v2; Jupiter
  AMM/CPMM routes do not imply a live AMM/CPMM price stream.

- Fix SDK live WebSocket preflight falsely reporting provider rejection when Bun on Windows synchronously dispatches the probe's normal close after a successful handshake.

- Liquidation CLI now plans/executes one wallet at a time, backs off temporary read failures, and continues after a wallet error. Token scans accept `--rpc-delay-ms` (2500 ms default). Execution errors stop fresh liquidation rounds; Jupiter fallback requires a proven pre-submission native failure.

- Fixed standalone range bot decision lag: fresh samples wake decisions immediately instead of waiting for the next polling tick; notifications arriving during trade work are retained. Logs include sampled market cap and sample age.

- Registry liquidation now prioritizes token exits across all wallets before rent cleanup, rather than making later wallets wait for one wallet's empty-account closures.

- Standalone range bots support a shared watched `--ranges-csv` file, keyed by wallet/mint, with per-row validation and preserved captured transaction limits.
- Added a one-process range-bots runner with one CSV watcher, automatic valid-row startup, shared SDK/SOL-USD caching and bounded price-source backoff. Removed rows pause decisions while preserving positions and reconciliation.
- Submission reuses the exact-message fee verified by the balance preflight instead of making a duplicate fee RPC call. Trade-stage hooks now distinguish balance/rent checks, simulation, broadcast and settlement.
- Pump curve trades can reuse chain-validated curve state from an immediately preceding sample for at most one second, scoped to the connection and token metadata. Expiry, metadata changes and migration force a fresh read; output calculations and transaction guards are unchanged.

- Fix custom-quote conversion discovery stalls and zero-slippage funding swaps on absolute-price buys. Final price ceilings and guaranteed intermediate spending remain enforced.
- Correct quote-to-SOL fallback sizing for expensive quote assets; fail explicitly if a bounded small-notional probe cannot be obtained.
- Avoid duplicate blockhash/ALT reads during immediate trade fee recompilation; freshness is bounded and never extended by reuse.
- Add RPC/Jupiter queue-versus-network measurements and enable core measurement streaming in the range manager.
- Preserve unknown manual-exit accounting in history instead of leaving a stale OPEN position or inventing a sell receipt.
- Add opt-in trade RPC admission priority with bounded background access; detailed composer quote/instruction spans identify conversion legs.
- Encode absolute Jupiter minima in supported route instructions instead of retaining the original zero-slippage quote. Request compact routes and recognize program-attributed Jupiter slippage errors. V1 transaction construction remains pending.
- Add native v1 assembly/signing via the official web3.js v3 codec alongside protocol SDK web3.js 1.x. Expose transactionVersion: 1 in SDK/core options; enable it in range bots. Retain native v1 through base64 RPC simulation, fee checks, senders and exact-byte restart recovery. Enforce 4096 bytes, resource config and account/instruction limits; preserve v0 defaults.
- Add wallets/balances --except <group1,group2> filters, including virtual ungrouped. Keep verified-empty archival in existing groups rather than splitting keys/history across databases.
- Avoid rediscovering registered liquidation routes through unrelated protocols; preserve freshly verified holding program/decimals.

- Add read-only FAIRS launch inventory/config preparation for managed wallets holding at least 0.1 SOL; draft buy amounts fail closed until specified. Record the four-buyer atomic bundle limit explicitly.


- Add unsigned FAIRS single-v1-transaction review script: creation plus sequential protected buys, current participant budget checks, actual assembly limits and simulation; no signing or submission. Required launch metadata and amounts remain unset.


- Isolate per-token range history accounting failures; preserve prior detailed CSV and show ACCOUNTING_REVIEW while allowing other token histories to publish.


- Recover missing accounting on already-confirmed intents using version-1-compatible parsed RPC responses; keep rent and fees separate and persist the recovered original fill. Range bots retain pending state while fill metadata is unavailable.


- Bound automatic trade priority-fee discovery to250ms with account-scoped cache, single-flight lookups and failure cooldown; retain fee floors/caps and fixed-bid semantics. Disable optional fee transport retries so HTTP429 cannot stall sells for10seconds.


- Remove implicit default percentage funding haircut from custom-quote price-only buys; keep funding and final on-chain minima. Use shared controlled RPC transport for range conversion/supply reads rather than ungoverned web3 connections.


- Move range mint-supply and SOL/USD refreshes out of the decision critical path. Retain freshness bounds, coalesce reads and prevent old-cache refresh wake loops. Add regression proving a pending supply refresh does not block a valid sell signal.


- Permit lower market-cap exit targets for existing positions when sell<=buy; mark the band entryPaused and prevent all new buys until a non-overlapping range is restored. Fixes an invalid-range pause blocking CP3Y's37kexit.


- Preserve explicit manual-exit entry pauses across restarts so reconciling an externally closed position cannot immediately buy it back. Verify AWyr's external exit separately from its earlier bot-completed cycle.


- Fix balance-read error handling so provider/validation failures cannot become false zero holdings; decode uncached mint metadata and supply in one RPC snapshot.


- Preserve honest range sample age across slow RPC/conversion requests; report wallet queue latency separately from build latency. Trading remains stopped pending further reliability work.

### Local range console (unreleased)

- Added local position and range dashboard at http://127.0.0.1:3817, backed by actual bot snapshots and trade CSVs.
- Added slider/numeric range editing with explicit Apply, CSRF/origin checks, revision checks, exclusive Windows file writes and backups. Stopped workers remain stopped.
- Fixed range editing for registered wallet names containing hyphens or underscores; added an API regression test.
- Added a separate `bid-ask.ts` ladder strategy with half-budget initialization, fixed or remaining-balance portions, explicit bounds, independent sampling, protected background preparation and durable original-order recovery. Defaults to paper mode; no live instance started.
- Added an explicit second-mint selection to the range runner, sharing one SDK wallet queue without starting historical CSV rows.
- Selected range startup now honors an explicit RPC preference and binds all worker reads to the readiness-selected endpoint, including fallback.
- Batched selected native Pump/PumpSwap price observations across tokens, retaining source timestamps, mint/vault identity checks, migration unavailability and protocol virtual quote reserves. This avoids full trade-route reconstruction on each price sample.
- Added validated external-acquisition entries to range history so explicitly adopted holdings retain their original signature and fee-inclusive cost when paired with a later bot sale.

- Fix archive-only test failure caused by core's allocation manager importing root bid-ask application files. Move that application manager/test to strategy/, keep it in root test coverage, and keep npm archive core tests enabled. Run release preflight before bumping versions.
- Expose core transaction composition through SDK tx(), compileGroups(), simulatePlan() and sendBatchPlans(); add composeTransactionDrafts with preserved actions/minima, signers, tracking and explicit resource budgets. Pin group lifetimes and reject missing co-signers before signing. Preserve raw instruction call order around async operations and materialize concurrent builds once. Existing Pump CLI grouping remains unchanged.
- Show saved/stopped and unallocated states explicitly in the allocation UI instead of unexplained blank balances.

- STRAWHAT preparation revision: luffy2 image, separate creator fee beneficiary, and 4.5 SOL across eight buyers; execution checks the approved creator address.

- Prepared STRAWHAT exit generation now pays fees and tips from a buyer and rejects inclusion of the deployer account; historical execution artifacts remain unchanged.

- STRAWHAT repeated-launch preparation supports isolated artifact directories and mint-specific reservations; new exits reject any deployer account before live signing.

- Repeated STRAWHAT preparation accepts explicitly reviewed $5k/$7k exit floors and checks the matching live confirmation argument.

- Prepared repeated STRAWHAT launches validate an explicit 3.5/4.5 SOL aggregate budget against live confirmation and signed templates.

- Authorized STRAWHAT repeat4 supports a 3 SOL budget and explicitly zero on-chain sell minima; confirmation must match the zero floor.

- Prepared launch dispatch now routes journaled single-transaction exits directly through RPC while retaining Jito for the launch bundle. BIBI preparation uses mint-specific Fairfun URL and configurable metadata; no live BIBI broadcast is authorized.

- Block future prepared/live launch allocations containing user-excluded buyer wallets; retain existing journal exits for already acquired tokens.


- Support explicit reviewed launch buyer lists and creator fee recipients for unsigned campaign preparation; prepare Bow with six eligible buyers.


- Enforce individual buyer transactions and the five-transaction Jito launch cap, retaining grouped sells and existing journal resumes.


- Allow the requested 4000 USD-equivalent Bow exit floor; validate exit wallet scope against the reviewed buyer list rather than a fixed count of eight.


- Prepare actual Pump fee-sharing creation/update instructions for Bow, with simulation verification of exact recipients and shares.


- Avoid rewriting an unchanged vanity reservation when resuming a previously reserved mint, reducing SQLite write contention before signing.


- Add native Pump holder-reward deployment flag, protocol gate validation and reward-PDA routing; prepare a 2.5 SOL four-buyer Bow review.


- Add persisted launch-and-hold mode that does not sign or submit exit transactions and rejects resume policy changes.


- Add per-wallet entry-relative launch exit floors and sequential RPC exits with durable confirmed-signature history. Prepare Louie and Aped relaunches using original metadata/image references and holder rewards.


- Allow explicit per-wallet launch allocations with exact selected-wallet and total-budget validation; prepare the FMCL relaunch without spending reserves needed by open positions.


- Add explicit capped launch batching with partial-execution reporting and authoritative post-launch fill reconciliation before exit signing. Prepare 1 SOL/eight-wallet Mackerel and neet campaigns.

# Unreleased launch execution changes

- Allow a dedicated deployer per campaign with persisted wallet identity and idempotent reserve funding.

- Preserve later-added token holdings when exiting an existing campaign; omit ATA closure only for accounts retaining extras and keep all output floors unchanged.

- Support exact confirmed fills in a combined multi-wallet exit, including a three-buyer 2 SOL campaign with one RPC sell transaction.

- Support two buyers per launch transaction with explicit persisted buyer mappings.
- Require one atomic bundle for new campaigns; preserve resume compatibility for existing journals.
- Reconcile packed buyers from confirmed wallet-specific token deltas before signing exits.
