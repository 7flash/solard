Solard Meteora live-manager V19

Apply after V18.

Behavior change
---------------
`examples/meteora-liquidity-agent.ts --live` is now a continuous position manager by default.
The process executes a cycle, waits for the next fully closed 5m candle (+ settle-ms),
reconciles the on-chain position, and moves it when the target candle range shifts by
at least --min-shift-bins (default 1).

Use --once when you intentionally want one live cycle and process exit.
`--loop` remains supported for backwards compatibility and to loop previews.
`--once` and `--loop` together are rejected.

After an LP already exists, do not pass --sol or --resume-bootstrap just to manage it.
With exactly one position in wallet+pool, the agent adopts it automatically. If several
positions exist, use --position <address> to disambiguate.

Recommended manager:

  $env:SOLARD_ENABLE_LIVE_TRADES="1"
  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/meteora-liquidity-agent.ts `
    --token <TOKEN_MINT> `
    --wallet pumpfun `
    --live

Explicit one-shot live cycle:

  ... --token <TOKEN_MINT> --wallet pumpfun --live --once

Preview remains one cycle by default:

  ... --token <TOKEN_MINT> --wallet pumpfun

Looping preview remains explicit:

  ... --token <TOKEN_MINT> --wallet pumpfun --loop
