Solard LP agent / measure-fn v4 fix

Changed files:
  examples/meteora-liquidity-agent.ts
  packages/core/src/venues/meteora/dlmm.ts
  packages/core/src/chain/meteora-liquidation.ts
  packages/core/src/core/log.ts
  packages/cli/src/index.ts

Fixes:
1. movePositionFromSource owner type crash
   resolveWalletAddress() returns a base58 string, while walletAccountingSnapshot()
   requires PublicKey. The move path now converts once with asPublicKey() before
   reading parsed token accounts. This fixes:
     ownerAddress.toBase58 is not a function

2. Literal previous-closed-5m-candle range
   The example no longer imposes min-bins=35 and no longer shifts the candle range
   onto a one-sided inventory range. Defaults are now:
     padding-bins = 0
     no minimum width unless --min-bins is explicitly supplied
     min-shift-bins = 1
   The target is low->round-down bin through high->round-up bin.

3. Infrastructure preflight before any source close
   The agent calls inspectPositionInfrastructure() for the exact target range.
   Missing bin arrays / bitmap extension are denied before movePositionFromSource()
   can close the old position unless the explicit allow flags and hard lamport cap
   are present. The agent also prebuilds an equivalent replacement using the source
   snapshot inventory before closing, so predictable SDK construction failures are
   caught while the old position is still open.

4. Agent runtime output uses measure-fn
   The example enables measure-fn streaming and wraps pool resolution, candle read,
   reconciliation, infrastructure inspection, build/open/move and the 5m wait.
   Ordinary runtime progress is no longer handwritten process.stdout output.

5. --measure-stream now streams AND collects
   The CLI uses measure-fn logger middleware: it feeds each event into the aggregate
   collector and calls next() for the built-in live formatter. PERF no longer ends
   with measure=0 merely because --measure-stream was enabled.

6. all-wallet Meteora liquidation progress
   Retains the per-wallet scan and per-position close measurements from v3.

Recommended command:
  $env:SOLARD_ENABLE_LIVE_TRADES="1"
  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/meteora-liquidity-agent.ts `
    --token <TOKEN_MINT> `
    --wallet pumpfun `
    --loop `
    --live

The existing open position is reconciled from chain. Do not pass --sol again merely
because the process restarted. Use --sol only when there is no position and you
intend to bootstrap new principal.
