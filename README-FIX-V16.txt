SOLARD METEORA BREAKOUT DEFAULT FIX V16

Problem
-------
meteora-liquidity-agent.ts documented --max-breakout-bins 50, and the Meteora
autopilot policy also uses 50, but the standalone agent actually defaulted the
flag to 0. That made any active bin even one bin outside the previous closed 5m
candle abort the cycle before bootstrap/open preflight.

Example observed:
  previous candle range: -354..-325
  active bin:            -321
  breakout:              4 bins
  old implicit limit:    0 bins
  result:                skip

Fix
---
The standalone agent now uses DEFAULT_MAX_BREAKOUT_BINS=50 everywhere the
breakout policy is read or displayed. --max-breakout-bins 0 remains available
when strict previous-candle containment is desired.

The target range itself is NOT silently moved. It remains the previous closed
5m candle range (plus only explicit --padding-bins/--min-bins widening). The
breakout limit only decides whether a small move beyond that old range should
prevent the cycle from continuing.

Immediate command equivalent (works even before applying V16):

  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/meteora-liquidity-agent.ts `
    --sol 0.2 `
    --token A4BreBGdt4ia1x9HG3ZJAiZQq2XgRD1KSXUt3Cy8ngod `
    --wallet pumpfun `
    --max-breakout-bins 50

After applying V16 the last flag is no longer necessary.

Important
---------
A tolerated breakout does not mean the current active bin is inside the old
candle range. In the example above the agent may prepare an LP whose range ends
at -325 while spot is at -321. That is intentional for the literal
"previous-closed-5m-candle" policy. If you instead want the bootstrap range to
always contain spot, that is a DIFFERENT range policy and should be implemented
explicitly rather than silently mutating the candle strategy.
