SOLARD METEORA 5M CANDLE LP

This patch adds:

  slrd meteora lp-5m [<pool>] --wallet <wallet> [--loop] [--live]

Behavior:
- Manages EXISTING Meteora positions only. It does not discover/deploy new pools.
- Uses the most recent fully closed 5-minute Meteora candle.
- Converts candle low/high to DLMM bins and pads outward by 1 bin by default.
- Rebalances only when the target shifts by at least 5 bins by default.
- If source inventory is one-sided, keeps the candle-derived width but places it on the fundable side of the active bin. No swap is performed.
- Skips a pool when spot is more than 50 bins outside the previous candle by default.
- Before closing anything in live mode, builds the replacement once as a preflight so invalid ranges/default-denied infrastructure requirements fail while the source position is still intact.
- Live source-only moves reuse only inventory recovered from the exact position being closed.
- Loop runs just after each 5m candle boundary (5 second settle delay by default).

PREVIEW ONCE

bun run .\packages\solard-cli\bin\solard.ts meteora lp-5m --wallet phantom

PREVIEW ONE POOL

bun run .\packages\solard-cli\bin\solard.ts meteora lp-5m <POOL> --wallet phantom

LIVE LOOP

$env:SOLARD_ENABLE_LIVE_TRADES="1"

bun run .\packages\solard-cli\bin\solard.ts meteora lp-5m `
  --wallet phantom `
  --loop `
  --live

LIVE LOOP FOR ONE POOL

bun run .\packages\solard-cli\bin\solard.ts meteora lp-5m <POOL> `
  --wallet phantom `
  --loop `
  --live

DEFAULTS / TUNING

--padding-bins 1
--min-bins 35
--min-shift-bins 5
--max-breakout-bins 50
--settle-ms 5000
--slippage-bps 100

If the target range requires new shared Meteora infrastructure, the command denies that spend by default. To explicitly allow it, provide the corresponding allow flag plus a hard lamport cap, for example:

--allow-bin-array-init --max-infra-lamports <LAMPORTS>

Simulation and normal transaction preflight remain enabled unless explicitly skipped.
