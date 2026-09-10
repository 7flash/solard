Solard value-band crossing controller V22
=========================================

Purpose
-------
Make the lower value-band trigger edge-based instead of level-based.

Old failure
-----------
With a 0.060 <- 0.100 -> 0.130 band and sell-fraction=0.70:

  position reaches 0.130
  -> controller sells 70%
  -> remaining position is about 0.039
  -> old controller sees 0.039 < 0.060
  -> lower buy can fire because OUR OWN SELL moved exposure below the threshold

That is not a market dip signal.

V22 state machine
-----------------
1. Upper-band SELL always sets lowerArmed=false.
2. While disarmed and below/equal lower: HOLD.
3. Market liquidation value must be observed strictly ABOVE lower to rearm.
4. Once armed, only a later ABOVE -> BELOW lower transition may trigger a buy.
5. Successful lower buys disarm the edge as before.
6. Fresh zero-inventory controllers still bootstrap toward base automatically.
7. A restart below lower with old/used capital does not invent a crossing.

Example with the user's current policy:

  lower=0.060, base=0.100, upper=0.130, sell=70%

  0.130 -> SELL 70%
  0.039 -> HOLD, lower disarmed
  0.045 -> HOLD
  0.059 -> HOLD
  0.061 -> REARM only
  0.070 -> HOLD, armed
  0.059 -> BUY (real market downward crossing)

Persistence
-----------
The existing version-1 journal remains compatible. V22 adds a lowerSide field
("above" | "below" | null). Old journals load with lowerSide=null and migrate
safely. The side is written only when it changes, not every sample.

Backtests
---------
packages/core/src/backtest/value-band-sim.ts now uses the same state machine.
This is important: research results and live behavior should not disagree about
whether a sell-created low exposure is a lower-band buy signal.

Tests added/updated
-------------------
- zero position bootstrap remains enabled
- lower buy requires above -> below transition
- upper sale cannot manufacture immediate lower buy
- recovery above lower rearms without buying
- subsequent real downward crossing buys
- restart below lower cannot invent an edge
- net-capital cap remains enforced
- simulator reproduces the same semantics

Files
-----
examples/value-band-trading-agent.ts
packages/core/src/strategy/value-band.ts
packages/core/src/strategy/value-band.test.ts
packages/core/src/backtest/value-band-sim.ts
packages/core/src/backtest/value-band-sim.test.ts
apply-v22.ps1

Operational note
----------------
An already-running Bun process keeps the old code in memory. Stop the current
controller with q, apply V22, then restart the same command.
