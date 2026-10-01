# Changelog

## Unreleased

## 0.2.30 — 2026-10-06

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
