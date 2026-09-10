Solard Meteora continuous-manager hardening V20

Apply after V19.

Fixes
-----
1. --position is startup-only.
   A Meteora move closes the source position and creates a new position address.
   V19 could keep pinning the original --position flag on every cycle and fail on
   the first cycle after a successful rebalance. V20 gives state.managedPosition
   priority after startup, so the verified replacement is followed automatically.

2. Boundary scheduling is candle-derived.
   The next wake time is derived from the candle just processed rather than from
   Date.now() after the cycle. If a cycle begins just before a 5m boundary and
   finishes just after it, the agent no longer accidentally skips the newly closed
   candle and sleeps an extra five minutes.

3. Completed-candle dedupe.
   The process remembers the last successfully completed candle and refuses a
   duplicate write for the same candle unless --force is explicit.

4. Post-cycle verification.
   In live mode, the managed position is freshly verified after open/move/keep/skip.
   Open/move verify the exact target range; existing positions verify their current
   range. The replacement address is adopted only after verification succeeds.

5. Retryable failures retry promptly.
   Network/RPC/temporary OHLCV failures retry with bounded exponential backoff
   (default base --retry-ms 2000, capped at 30s) rather than immediately abandoning
   the current candle until the next 5m boundary.

Recommended already-open manager
--------------------------------
$env:SOLARD_ENABLE_LIVE_TRADES="1"

bun run .\packages\solard-cli\bin\solard.ts run `
  examples/meteora-liquidity-agent.ts `
  --token <TOKEN_MINT> `
  --wallet pumpfun `
  --live

If multiple positions exist at startup, seed the intended one once:

  ... --position <CURRENT_POSITION> --live

After the first move, do not edit the command to the replacement address; V20 follows
that new verified position automatically.
