Solard LP agent / Meteora scan v3

Changes
- Liquidity example no longer persists agent state to disk.
- On restart it reconciles from live wallet+pool positions:
    0 positions -> bootstrap only if explicit funding was supplied
    1 position  -> adopt it automatically
    >1 positions -> require --position to disambiguate
- --token <mint> is supported and resolves to an existing Meteora DLMM pool.
- If --pool accidentally contains a token mint, the example detects the DLMM
  discriminator failure and falls back to token-pool discovery.
- --sol pool discovery requires a WSOL pair and picks the highest-TVL exact match.
- Previous fully closed 5m candle is still the target source.
- Default infrastructure policy remains existing-bin-arrays-only. If the range
  needs new shared bin arrays/bitmap extension, the SDK refuses before building
  unless the explicit infrastructure allow/cap flags are supplied.
- Registry-wide Meteora liquidation scans now have measure-fn spans per wallet
  and per position close, so --measure-stream reports ongoing work instead of
  only the database-open span.

Recommended token invocation
  bun run .\\packages\\solard-cli\\bin\\solard.ts run `
    examples/meteora-liquidity-agent.ts `
    --token <TOKEN_MINT> `
    --wallet pumpfun `
    --sol 0.1 `
    --loop `
    --live

Direct pool invocation
  ... --pool <METEORA_DLMM_POOL> --wallet pumpfun --sol 0.1 --loop --live

If more than one position exists in the same wallet+pool:
  ... --position <POSITION_ADDRESS>

Debug all-wallet close scanning
  bun run .\\packages\\solard-cli\\bin\\solard.ts meteora close-all `
    --all-wallets --all-pools --measure-stream
