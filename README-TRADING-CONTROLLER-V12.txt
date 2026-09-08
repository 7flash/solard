SOLARD TRADING CONTROLLER V12
============================

This overlay is intended to be copied on top of the project after V11.
It does NOT replace packages/cli/src/index.ts, liquidation.ts, or the Meteora
V11 fix.

FILES
-----
examples/lib/trading-terminal.ts
examples/target-weight-trading-agent.ts
examples/value-band-trading-agent.ts
packages/core/src/strategy/value-band.ts
packages/core/src/strategy/value-band.test.ts

WHY THIS VERSION
----------------
1. The old target-weight example executed through createTraderSolard().buy/sell().
   The standard trader preset installs Pump/PumpSwap venues, so that is not a
   reliable execution path for a Raydium/LaunchLab token.

2. Both live trading examples now execute through Solard's existing generic
   Jupiter Swap V2 helpers. Jupiter chooses the underlying route. The strategy
   does not need to know whether LEVERCAT is currently routed through Raydium,
   LaunchLab migration liquidity, or another supported venue.

3. Position value means executable full-position token->SOL liquidation quote,
   not chart close * token count. This makes transfer fees, route friction and
   size impact visible to the controller.

4. measure-fn no longer owns stdout for these agents. A replacement logger writes
   measure events to JSONL while stdout is reserved for a stable interactive
   dashboard.

5. Value-band averaging down is bounded by a hard NET capital-deployment cap.
   Realized sell proceeds can be recycled, but the strategy will not increase its
   net SOL principal beyond --max-capital-sol.

6. The lower threshold is edge-triggered. After a lower-band buy, it is disarmed
   until liquidation value recovers above the lower threshold. This prevents a
   taxed token from causing another buy every five seconds merely because the
   first buy did not move executable liquidation value above the threshold.

JUPITER REQUIREMENT
-------------------
The existing Solard Jupiter transport requires JUPITER_API_KEY.
The existing default limiter is SLRD_JUPITER_MAX_RPS=1 unless you override it.
Quote-based exact sizing therefore intentionally happens only when a rebalance is
actually required, not on every screen refresh.

TARGET-WEIGHT / LEVERCAT
------------------------
Dry loop:

  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/target-weight-trading-agent.ts `
    --token AGi2s9zPRPHs3zEDPhPTroumTEXK5ufymYSfEFndCSSW `
    --wallet pumpfun `
    --target-weight 40 `
    --gap-pct 3 `
    --inner-gap-pct 1 `
    --reserve-sol 0.02 `
    --loop

Live:

  $env:SOLARD_ENABLE_LIVE_TRADES="1"

  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/target-weight-trading-agent.ts `
    --token AGi2s9zPRPHs3zEDPhPTroumTEXK5ufymYSfEFndCSSW `
    --wallet pumpfun `
    --target-weight 40 `
    --gap-pct 3 `
    --inner-gap-pct 1 `
    --reserve-sol 0.02 `
    --loop `
    --live

Fixed-gap behavior is literally:

  weight < 37%  -> buy toward approximately 39%
  37..43%       -> hold
  weight > 43%  -> sell toward approximately 41%

Sizing uses hypothetical executable Jupiter quotes and a short binary search, so
"toward 39%" and "toward 41%" account for the asset's executable friction better
than chart-price algebra.

Interactive keys:

  + / -   change target weight by --step-weight (default 1 percentage point)
  p       pause/resume writes
  b       request a rebalance immediately instead of waiting for the next 5m close
  q       quit

The normal cadence remains previous-closed-5m. --rebalance-now performs the first
check immediately. Adaptive --gap-mode previous-5m-vol remains available, but the
fixed 3pp band is the cleaner starting point for a high-friction token.

VALUE BAND / 0.05 <- 0.10 -> 0.18
--------------------------------
If you already hold the initial sleeve:

  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/value-band-trading-agent.ts `
    --token AGi2s9zPRPHs3zEDPhPTroumTEXK5ufymYSfEFndCSSW `
    --wallet pumpfun `
    --base-sol 0.1 `
    --max-capital-sol 0.5 `
    --loop

Live:

  $env:SOLARD_ENABLE_LIVE_TRADES="1"

  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/value-band-trading-agent.ts `
    --token AGi2s9zPRPHs3zEDPhPTroumTEXK5ufymYSfEFndCSSW `
    --wallet pumpfun `
    --base-sol 0.1 `
    --max-capital-sol 0.5 `
    --loop `
    --live

Defaults:

  base                 0.10 SOL executable liquidation value
  lower                base * 0.50 = 0.05 SOL
  upper                base * 1.80 = 0.18 SOL
  upper action          sell 50% of current token units
  lower buy mode        same-value
  max per buy           base (0.10 SOL unless overridden)
  max net capital       base * 5 (0.50 SOL unless overridden)
  sample                5 seconds
  cooldown              10 seconds after a successful trade

Buy modes:

  --buy-mode same-value
      Spend SOL equal to the current executable liquidation value, capped by
      --max-buy-sol and remaining net-capital budget. This is the old
      "match-current" interpretation and is also accepted as --buy-mode match-current.

  --buy-mode same-tokens
      Binary-search the SOL input required for the expected Jupiter output to
      approximately equal the number of token units currently held. This is the
      literal "buy the same number of tokens" interpretation.

  --buy-mode to-base
      Binary-search a SOL input whose hypothetical combined bag liquidates near
      --base-sol. This explicitly models the round-trip friction while sizing.

If there is no initial token sleeve, or you intentionally increase confidence:

  ... --base-sol 1 --scale-now --loop --live

--scale-now reads the existing on-chain token inventory and buys only toward the
new executable base. It is still bounded by --max-buy-sol, wallet reserve and
--max-capital-sol.

Interactive keys:

  + / -   change base by --step-sol; lower/upper scale with the original ratios
  p       pause/resume writes
  r       explicitly re-arm the lower threshold
  b       scale toward the current base now
  q       quit

RISK JOURNAL
------------
Token inventory is NOT persisted as strategy truth. Every loop reads the current
associated token account and an executable liquidation quote from chain/Jupiter.

The value-band agent does persist only the information chain state cannot tell us:

  lowerArmed
  cumulativeBuySol
  cumulativeSellSol
  peakNetCapitalDeployedSol

Default location:

  .solard/agents/value-band-<wallet>-<mint>.json

This makes the capital cap survive restarts without pretending a local token
balance is authoritative. Use --state-file only when you intentionally want a
separate independent risk journal.

LOGGING
-------
By default each run creates:

  .solard/logs/<agent>-<timestamp>.jsonl

The file contains measure-fn events plus controller decisions, controls,
executions and errors. Pass --log <path> to choose another file.

The dashboard therefore stays readable while detailed RPC/Jupiter/measure traces
remain inspectable after the fact.

IMPORTANT
---------
This V12 overlay does not add Raydium token-history backfill or StonkFun reward
attribution yet. Those are separate from the live controller and should be the
next patch. This version also does not claim a user-configurable Jupiter slippage
parameter because the current project's Jupiter Swap V2 transport does not pass
one in /order; adding a CLI flag that the transport ignores would be misleading.
