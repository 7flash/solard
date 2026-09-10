SOLARD V18 — DIRECT RAYDIUM EXECUTION + METEORA BOOTSTRAP RECOVERY

POSITION CONTROLLER
- Adds --venue auto|jupiter|raydium (default auto).
- auto quotes Jupiter and Raydium and selects the route with the larger exact-in output.
- --venue raydium bypasses Jupiter execution entirely and uses Solard's Raydium Trade API builder.
- Raydium quote/execution still pays underlying pool/LP fees and Solana network fees; it avoids a separate Jupiter execution leg.
- Optional --raydium-priority-micro-lamports N overrides Raydium auto priority pricing. N=0 minimizes priority fee but may confirm more slowly.
- Dashboard shows requested routing mode and the route currently selected for liquidation.

Example direct Raydium preview:
  bun run .\packages\solard-cli\bin\solard.ts run `
    examples/position-controller.ts `
    --mode value `
    --token <MINT> `
    --wallet pumpfun `
    --base-sol 0.1 `
    --lower-multiple 0.5 `
    --upper-multiple 1.8 `
    --sell-fraction 0.5 `
    --buy-mode same-value `
    --max-capital-sol 0.5 `
    --max-buy-sol 0.1 `
    --reserve-sol 0.02 `
    --venue raydium `
    --raydium-priority-micro-lamports 0 `
    --loop

METEORA
- Post-swap token verification now polls confirmed/finalized wallet balances instead of doing one immediate read.
- If balance indexing still lags, the agent inspects confirmed transaction token deltas and reports that the swap succeeded instead of encouraging a repeat.
- If a previous bootstrap swap succeeded but the process died before opening the LP, a later run detects existing output inventory and REFUSES another --sol swap by default.
- --resume-bootstrap explicitly adopts existing output inventory, scales the WSOL side to the current target ratio, and continues to position construction without performing another balancing swap.
- Adds --post-swap-balance-attempts N (default 12).

IMPORTANT RECOVERY FOR AN ALREADY-INTERRUPTED BOOTSTRAP
1. Do not repeat a live --sol bootstrap blindly.
2. Inspect the wallet:
     slrd balances --wallet pumpfun --token <POOL_TOKEN_MINT>
3. If the output token is present and belongs to this interrupted bootstrap, resume:
     bun run .\packages\solard-cli\bin\solard.ts run `
       examples/meteora-liquidity-agent.ts `
       --sol 0.2 `
       --token <POOL_TOKEN_MINT> `
       --wallet pumpfun `
       --resume-bootstrap `
       --live

The resume path does not execute another balancing swap when existing output inventory is detected.
