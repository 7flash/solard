# Changelog

## Unreleased

- Expose read-only grouped creator-fee discovery and bounded claims for Pump/PumpSwap, LaunchLab/CPMM and eligible Meteora creator positions, with explicit unsupported/error coverage.
- Add the LaunchLab launchpad, named platform presets, atomic SOL-funded custom-quote creator buys, shared landing and confirmed cost fields.
- Add migration-aware SDK trade subscriptions, verified current-market discovery and mint-bearing CPMM price events. AMM v4 live prices remain unsupported.
- Export value-band/target-weight strategy helpers and cached historical tape, sparse candles, delayed-fill simulation and parameter sweeps.
- Add exact observed wallet ledger components with residual/partial-history reporting; batch empty-account maintenance, explicit dust burn and opt-in full-sell account closure.
- Scope pre-generated vanity inventory to the caller's database and decode Pump's exact whitelist slot rather than following fields.
- Funded acceptance, publish authentication, fuller launch/batch intent persistence and historical/live coverage gaps remain open; see docs/mements-capabilities.md.

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
