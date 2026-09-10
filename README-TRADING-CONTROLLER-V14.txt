SOLARD TRADING CONTROLLER V14
============================

Apply after V12 (and it is safe to apply after V13):

  .\apply-v14.ps1 -Repo C:\Code\solwal

WHY V14 EXISTS
--------------
V12 mixed two concepts:
1. measure-fn instrumentation; and
2. a second ad-hoc audit.event() stream.

That was unnecessary. V14 removes the ad-hoc event stream completely.
Every control change, decision, sizing operation, snapshot and execution is now
represented by scoped measure-fn operations. The application installs a
replacement measure-fn logger with configureSolardMeasure({ logger }). The
replacement logger DOES NOT call next(), so measure-fn emits nothing to stdout.
The dashboard therefore owns stdout while the raw measure-fn event stream is
written to a .measure.log file.

There is no separate trading logging protocol.

VALUE BAND
----------
Value-band controls ABSOLUTE executable token liquidation value.

With:
  --base-sol 0.1
  --lower-multiple 0.5
  --upper-multiple 1.8

it means:
  lower = 0.05 SOL
  base  = 0.10 SOL
  upper = 0.18 SOL

At/above 0.18 it sells the configured fraction (default 50%).
Below 0.05 it performs the configured buy mode, subject to the hard capital cap.
For the LEVERCAT idea this is the direct strategy.

TARGET WEIGHT
-------------
Target-weight is a DIFFERENT strategy. It controls token value as a percentage
of a strategy portfolio, not as an absolute SOL sleeve.

Example with strategy NAV = 1.0 SOL and target = 40%:
  token liquidation value ~= 0.40 SOL
  strategy cash          ~= 0.60 SOL

With --gap-pct 3 --inner-gap-pct 1:
  below 37% -> buy toward ~39%
  37..43%   -> hold
  above 43% -> sell toward ~41%

As token price changes, NAV changes, so the desired absolute token value also
changes. This is useful for portfolio rebalancing. It is NOT the same as
"keep around 0.1 SOL worth of this token".

V14 also fixes an unsafe V12 assumption: target-weight no longer silently treats
all SOL in the wallet above --reserve-sol as strategy cash.

On FIRST target-weight run you must provide:
  --capital-sol <strategy NAV>

The agent values the token position from chain and initializes only the remaining
part as strategy cash. It persists only this strategy-cash bookkeeping in:
  .solard/agents/target-weight-*.json

Token inventory itself is always re-read from chain. Unrelated SOL in the wallet
is not added to target-weight NAV. Buy executions reduce strategy cash; sells add
the actual/observed SOL proceeds. To intentionally add more strategy capital:
  --add-capital-sol <N>

VALUE-BAND EXAMPLE
------------------
  $env:SOLARD_ENABLE_LIVE_TRADES="1"

  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/value-band-trading-agent.ts `
    --token AGi2s9zPRPHs3zEDPhPTroumTEXK5ufymYSfEFndCSSW `
    --wallet pumpfun `
    --base-sol 0.1 `
    --max-capital-sol 0.5 `
    --loop `
    --live

TARGET-WEIGHT EXAMPLE
---------------------
For a separate 1 SOL strategy envelope with a 40% token target:

  $env:SOLARD_ENABLE_LIVE_TRADES="1"

  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/target-weight-trading-agent.ts `
    --token AGi2s9zPRPHs3zEDPhPTroumTEXK5ufymYSfEFndCSSW `
    --wallet pumpfun `
    --capital-sol 1 `
    --target-weight 40 `
    --gap-pct 3 `
    --inner-gap-pct 1 `
    --reserve-sol 0.02 `
    --loop `
    --live

For the strategy described in the conversation, prefer VALUE-BAND unless the
goal explicitly changes to portfolio-percentage rebalancing.
