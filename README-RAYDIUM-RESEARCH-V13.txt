SOLARD RAYDIUM / LAUNCHLAB RESEARCH V13
=======================================

Apply after V11 and V12.

What V13 changes
----------------
1. `slrd token backfill <mint>` now falls back to Raydium/LaunchLab when the
   existing Pump history service raises UNSUPPORTED_TOKEN.
2. The Raydium backfill scans the deterministic LaunchLab SOL pool PDA when it
   exists plus the most liquid Raydium pools returned by API v3.
3. It reuses the existing SolanaTokenHistoryRpc. Paid Helius
   getTransactionsForAddress remains only a fast path; when unavailable the RPC
   layer falls back to getSignaturesForAddress + getTransaction batches.
4. Raydium transactions are normalized into the existing TokenHistoryTrade
   store from signer token/SOL/WSOL balance deltas. This measures the wallet's
   effective execution rather than pretending the pool chart price equals the
   amount a high-friction Token-2022 holder can actually realize.
5. The parser rejects target-token movements whose SOL direction does not match
   a buy/sell, which filters transfers and non-SOL quote activity.
6. Coverage keeps the v1 fields for compatibility and adds optional
   venueFamily/scanAddresses/launchLabPool/raydiumPools metadata.
7. Adds a bounded value-band simulator and unified StonkFun research suite.
8. Adds an xSOL balance/reward tracker. It deliberately labels observations
   balance-delta-only; a positive xSOL delta is not by itself proof StonkFun was
   the source.

Install
-------
Extract this zip somewhere, then from the extracted directory:

  .\apply-v13.ps1 -Repo C:\Code\solwal

Backfill LEVERCAT
-----------------
  slrd token backfill AGi2s9zPRPHs3zEDPhPTroumTEXK5ufymYSfEFndCSSW

Optional:
  --raydium-pools 8
  --replace
  --confirmed
  --max-signatures N

The Raydium API v3 pool lookup is only discovery. Historical transactions still
come from your configured Solana RPC. Raydium documents /pools/info/mint as the
mint-based pool discovery endpoint.

Unified research
----------------
  $mint = "AGi2s9zPRPHs3zEDPhPTroumTEXK5ufymYSfEFndCSSW"

  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/stonkfun-research-suite.ts `
    --token $mint `
    --capital-sol 1 `
    --base-sol 0.1 `
    --max-capital-sol 0.5 `
    --target-weight 40

It writes:
  report.json
  comparison.csv
  early-buyers.csv
  bundle-like-clusters.json
  ledger-value-band-same-value.csv
  ledger-value-band-to-base.csv
  ledger-value-band-same-tokens.csv

Comparison rows:
  hold a 0.1 SOL token sleeve with the remaining strategy capital idle in SOL
  value-band same-value
  value-band to-base
  value-band same-tokens
  target-weight 40%, 37/43 triggers -> 39/41 destinations
  legacy ATH -20% / +40% take-profit ladder

The value-band backtest reports peak net strategy capital deployed. This is the
important guard against the false claim that repeatedly buying below 0.05 SOL
remains a bounded 0.1 SOL bet.

Friction
--------
The suite calculates two different things and keeps them separate:

* Historical empirical spread: same-second median effective buy price vs median
  effective sell price when both exist. This is only an estimate because market
  movement and route composition can still influence it.
* Current Jupiter round trips for 0.01 / 0.05 / 0.10 SOL. These are current
  executable-route probes, not historical tax measurements.

Override the one-way simulation friction explicitly with:
  --execution-bps 400

Initial distribution / bundlers
-------------------------------
  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/raydium-initial-analysis.ts `
    AGi2s9zPRPHs3zEDPhPTroumTEXK5ufymYSfEFndCSSW 60

The research suite labels:
  same signature + >=2 early buyers -> bundle-like:same-signature
  same slot + >=3 early buyers      -> bundle-like:same-slot

Those are heuristics, NOT proof the wallets share a controller and NOT proof a
Jito bundle was used.

The current-largest-account section is explicitly a current snapshot. It must
not be described as genesis/initial allocation.

StonkFun / xSOL reward balance tracker
--------------------------------------
  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/stonkfun-reward-tracker.ts `
    --wallet pumpfun `
    --loop

Default reward mint:
  4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs

Override with --reward-mint <mint>.

The JSONL records balance changes and optional Jupiter liquidation value. It
intentionally does not claim exact StonkFun attribution until a verified
on-chain distributor/source is wired in.

Coverage semantics
------------------
For Raydium, fromCreation=true only when the deterministic LaunchLab pool exists
and its address history reaches its beginning without truncation. The oldest
reachable LaunchLab-pool transaction is used as the creation coverage marker.
If only migrated Raydium pools can be discovered, history can still be useful
but strict creation coverage remains false.

Validation
----------
This overlay is built from the exact source snapshot supplied in the chat. Pure
TypeScript modules were syntax/type checked with local stubs where possible.
The environment used to package it does not contain your repository's Bun
installation/node_modules, so run in C:\Code\solwal after applying:

  bun test packages/core/src/backtest/value-band-sim.test.ts
  bun test packages/core/src/chain/token-history
  bun run typecheck

Then run a non-destructive LEVERCAT backfill/research pass before relying on the
results for live trading.
