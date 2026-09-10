Solard Meteora funded-range verification V21
=============================================

Apply after V20.

What this fixes
---------------
V20 proves that Meteora created the requested position account bounds, e.g.
  lowerBin=-274 upperBin=-254
but those two numbers alone do not prove that every bin inside that interval
actually carries this position's liquidity.

V21 adds a stronger position-local proof from Meteora positionBinData:
- expected declared bins = lowerBin..upperBin
- funded bins = positionBinData rows with positionLiquidity > 0
- missing funded bins are reported explicitly
- fullRangeFunded=true only when every declared bin is proven funded

For the default Spot strategy the live manager is fail-closed:
- known partial coverage forces a source-capital-only rebuild even when the
  declared range itself has not moved
- after an open/rebalance, the replacement must verify both exact bounds and
  full funded-bin coverage
- if the replacement still has partial coverage, the manager stops instead of
  repeatedly closing/reopening and churning principal
- if the installed SDK does not expose enough per-bin data to prove coverage,
  the manager stops before autonomous management. The explicit escape hatch is
  --allow-unverified-bin-coverage.

CLI visibility
--------------
  slrd meteora positions --wallet pumpfun
now includes a FUNDED column:
  4/4     all declared bins funded
  3/4!    known partial coverage
  3/4?    coverage data incomplete/unverifiable
  ?       no usable per-bin proof

Recommended manager command for an existing position
-----------------------------------------------------
$env:SOLARD_ENABLE_LIVE_TRADES="1"

bun run .\packages\solard-cli\bin\solard.ts run `
  examples/meteora-liquidity-agent.ts `
  --token A4BreBGdt4ia1x9HG3ZJAiZQq2XgRD1KSXUt3Cy8ngod `
  --wallet pumpfun `
  --live

Do not pass --sol or --resume-bootstrap once the LP already exists.
Live mode remains continuous by default; Ctrl+C stops it, --once explicitly
requests one live cycle.

Validation
----------
The changed TypeScript sources were syntax/transpile checked with TypeScript
5.8.x. Full repo typecheck still requires the project's installed dependencies.
