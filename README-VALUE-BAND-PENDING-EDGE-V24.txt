Solard value-band pending-edge controller V24
============================================

Purpose
-------
V23 made both boundaries true market crossings. That exposed an execution-lifecycle
edge case: a valid crossing could happen while the controller was paused or still
inside the post-trade cooldown. The controller would observe the new boundary side
without trading, so once the cooldown expired the crossing had already been consumed
and the action could be missed entirely.

V24 adds a tiny persisted pending-trigger latch in the live controller.

Behavior
--------
- A BUY crossing that occurs while PAUSED or in cooldown is queued as pending BUY.
- A SELL crossing that occurs while PAUSED or in cooldown is queued as pending SELL.
- The pending trigger executes once trading is allowed again, but ONLY while the
  market/position is still on the triggering side of the boundary.
- If price recovers across the boundary before execution, the pending trigger is
  cancelled. A later fresh crossing can create a new trigger normally.
- Pending state is persisted in the existing version-1 journal, so stopping/restarting
  during a cooldown does not silently lose the edge.
- A manual scale-to-base action cancels any pending band trigger before sizing.
- Execution errors are NOT automatically queued/retried because an ambiguous submitted
  transaction must not be duplicated blindly. Existing error handling remains safer.

Example
-------
upper=0.130, cooldown still active:
  0.129 -> 0.132   crossing detected, SELL queued
  0.134            still above upper, cooldown expires -> SELL once

If instead:
  0.129 -> 0.132   SELL queued
  0.128            falls back below upper before cooldown ends -> pending SELL cancelled
  0.131 later      fresh crossing -> SELL

Dashboard
---------
Adds:
  Pending trigger   BUY / SELL / -

Files
-----
examples/value-band-trading-agent.ts
apply-v24.ps1
README-VALUE-BAND-PENDING-EDGE-V24.txt

Operational note
----------------
Stop an already-running controller with q before applying, then restart the same
position-controller command. Existing V23 journals load without migration.
