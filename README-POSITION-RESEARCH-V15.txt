SOLARD V15 — POSITION CONTROLLER + RESEARCH FIX

This overlay is intended to be applied after the previous V12/V13/V14 overlays.
It fixes the exact failures observed on 2026-09-08.

1. RESEARCH SUITE IS GENERIC AND USES THE CANONICAL DURABLE TAPE

Use:

  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/token-research-suite.ts `
    --token $mint `
    --capital-sol 1 `
    --base-sol 0.1 `
    --max-capital-sol 0.5 `
    --no-backfill

The V13 file name examples/stonkfun-research-suite.ts remains as a compatibility
wrapper, but it now runs the same generic token research engine.

V13 incorrectly filtered durable rows directly on row.priceSol. Pump curve rows
can legitimately have priceSol=null while still carrying exact token and economic
SOL deltas. Solard's normal backtest tape already derives a canonical price from
those deltas. V15 uses loadTokenBacktestTape(), so Pump, PumpSwap and Raydium tapes
all enter the strategy simulator through the same canonical replay surface.

The baseline no longer automatically applies a guessed/empirical execution cost.
Use --execution-bps N explicitly, or --use-empirical-friction if you intentionally
want the same-second empirical estimate applied to the simulation.

The generic suite prints an INITIAL section before the strategy table. It reports:
- early buy/sell flow by launch period;
- buy concentration;
- wallets that SELL BEFORE ANY RECORDED MARKET BUY;
- same-signature / same-slot bundle-like clusters.

"sell before recorded buy" means the complete market tape has no earlier market
buy for that wallet. It can indicate launch inventory, a creation-transaction buy,
an off-market transfer, or another inventory source. It is deliberately NOT
labelled proof of common ownership or wrongdoing.

Target-weight is no longer in the default comparison because it confused the main
absolute-value experiment. Add --include-weight (or --all) to include it as an
optional benchmark. Hold, the three value-band modes and the legacy strategy are
compared by default.

2. ZERO-POSITION VALUE CONTROLLER NOW BOOTSTRAPS AUTOMATICALLY

Previously:
  token value = 0
  same-value buy = 0
  -> endless "same-value buy below minimum"

V15 treats an empty token position as bootstrap-to-base. With --base-sol 0.1 it
sizes a buy toward a 0.1 SOL executable liquidation value, subject to the wallet
reserve, max-capital and max-buy limits. You no longer need to know about
--scale-now just to create the initial sleeve.

3. ONE USER-FACING POSITION CONTROLLER

Absolute liquidation-value mode (the strategy discussed originally):

  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/position-controller.ts `
    --mode value `
    --token $mint `
    --wallet pumpfun `
    --base-sol 0.1 `
    --lower-multiple 0.5 `
    --upper-multiple 1.8 `
    --sell-fraction 0.5 `
    --buy-mode same-value `
    --max-capital-sol 0.5 `
    --max-buy-sol 0.1 `
    --reserve-sol 0.02 `
    --loop

This means:
  token liquidation value < 0.05 SOL -> buy according to lower-band mode
  0.05..0.18 SOL                     -> hold
  token liquidation value > 0.18 SOL -> sell 50% of token units

Weight mode is the same user-facing controller with a different threshold policy:

  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/position-controller.ts `
    --mode weight `
    --token $mint `
    --wallet pumpfun `
    --capital-sol 1 `
    --target-weight 40 `
    --gap-pct 3 `
    --inner-gap-pct 1 `
    --loop

Here "portfolio" means ONLY the capital explicitly assigned to this strategy:
strategy cash + executable token liquidation value. It never means the whole wallet.
At 1 SOL strategy NAV and 40% target, the desired token share is around 0.4 SOL.
If strategy NAV grows to 2 SOL, 40% is around 0.8 SOL. This is why weight mode is
different from the fixed 0.1-SOL value mode.

For the user's stated LEVERCAT / meme-token sleeve idea, use --mode value.
Weight mode is optional research/portfolio management.

4. MEASURE-FN REMAINS THE ONLY LOGGING SYSTEM

V14 wrote the structured MeasureLogEvent as JSON. V15 removes that representation.
The configured measure-fn logger now calls measure-fn's next() built-in renderer
while temporarily routing its stdout/stderr writes into the .measure.log file.
Therefore the file contains the familiar human-readable measure-fn output, e.g.:

  [slrd:value-band-agent:a] -> start
  [slrd:value-band-agent:a] ok 0.41ms -> {...}

rather than one JSON object per line.

No separate audit/event logging API is used. Decisions, controls, snapshots, sizing
and executions remain ordinary scoped measure-fn operations.

5. DASHBOARD USES THE TERMINAL ALTERNATE SCREEN

The controller enters the terminal alternate screen buffer and repaints only when
the visible frame changes. Repeated refreshes no longer accumulate copies of the
dashboard in ordinary terminal scrollback. On quit the previous terminal screen is
restored.

LIVE VALUE MODE

  $env:SOLARD_ENABLE_LIVE_TRADES="1"

  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/position-controller.ts `
    --mode value `
    --token $mint `
    --wallet pumpfun `
    --base-sol 0.1 `
    --lower-multiple 0.5 `
    --upper-multiple 1.8 `
    --sell-fraction 0.5 `
    --buy-mode same-value `
    --max-capital-sol 0.5 `
    --max-buy-sol 0.1 `
    --reserve-sol 0.02 `
    --loop `
    --live

Always inspect the dry-run executable quote/action before enabling live trading.
