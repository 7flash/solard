Solard value-band V25 — return-to-band with executable-price guards

Why this patch exists
---------------------
V22-V24 made the lower edge a strict crossing/rearm state machine and V24 could
persist a pending BUY through cooldown. That was too clever for the intended
strategy:

- a deep dump could be ignored while the lower edge waited for a rebound/rearm;
- a stale pending BUY could survive until a later rebound because whole-position
  liquidation was still below the lower threshold after previous selling;
- that BUY could then add exposure at a much worse price than the dip that was
  missed;
- after the stale BUY, the position could be oversized even though the correct
  action at the fresh snapshot should have been SELL.

V25 removes the rebound/rearm requirement and removes queued band signals.
Every eligible cycle re-reads the current executable state and decides again.

Decision priority
-----------------
1. If current executable liquidation >= upper band: SELL has absolute priority.
   This is level-based, not crossing-based. If a partial sell still leaves the
   sleeve over the upper band, another eligible cycle may continue reducing it.

2. If liquidation < lower band: BUY is allowed only when its price guard passes.

   After a SELL:
     current executable SOL/token price must be at least
     --rebuy-after-sell-drop-pct below the last sell price.

   After a BUY:
     another averaging buy requires another
     --lower-ladder-drop-pct decline from the last buy price.

   This gives a real averaging-down ladder without requiring a rebound above the
   lower value threshold.

3. Inside the band: HOLD.

Cooldown / pause semantics
--------------------------
Signals are NOT queued anymore. When cooldown ends or pause is released, the
controller takes a fresh balance + executable quote and re-evaluates from scratch.
This prevents a stale BUY observed several seconds/minutes earlier from executing
on a rebound.

Defaults
--------
--rebuy-after-sell-drop-pct 12
--lower-ladder-drop-pct 15

Example with a sell around $388k equivalent price:
- 12% post-sell retrace -> rebuy guard around $341k
- 15% post-sell retrace -> around $330k

These comparisons are performed with the controller's executable SOL/token price,
not UI market cap. Market-cap numbers are only a visual analogy.

State migration
---------------
Existing V22/V23/V24 journal files are accepted. Legacy lowerArmed/upperArmed/
pendingAction fields are ignored and disappear on the next journal write.
The new journal stores last buy/sell executable-price anchors and timestamps.

Manual control
--------------
'r' now resets the buy price guard/anchors. It does not perform a trade; the next
cycle evaluates the current band normally.

Recommended live command
------------------------
$env:SOLARD_ENABLE_LIVE_TRADES="1"

bun run .\packages\solard-cli\bin\solard.ts run `
  examples/position-controller.ts `
  --mode value `
  --token <MINT> `
  --wallet pumpfun `
  --base-sol 0.1 `
  --lower-multiple 0.6 `
  --upper-multiple 1.3 `
  --sell-fraction 0.7 `
  --buy-mode same-value `
  --max-capital-sol 0.5 `
  --max-buy-sol 0.1 `
  --reserve-sol 0.02 `
  --rebuy-after-sell-drop-pct 12 `
  --lower-ladder-drop-pct 15 `
  --loop --live
