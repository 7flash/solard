SOLARD LIQUIDITY AGENT + CLEANUP PATCH

What changed
------------
1. Removed the previous-5m LP strategy from `slrd meteora` commands.
   Strategies stay outside the kernel and use the public @solard/sdk.

2. Added:
   examples/meteora-liquidity-agent.ts

   Run preview:
     slrd run examples/meteora-liquidity-agent.ts --pool <POOL> --wallet pumpfun

   Bootstrap when no position exists (WSOL pool):
     slrd run examples/meteora-liquidity-agent.ts --pool <POOL> --wallet pumpfun --sol 0.1

   Live loop:
     $env:SOLARD_ENABLE_LIVE_TRADES="1"
     slrd run examples/meteora-liquidity-agent.ts --pool <POOL> --wallet pumpfun --sol 0.1 --loop --live

   The agent persists the exact position it manages under .solard/agents by default.
   Existing positions are never auto-adopted: pass --position <POSITION> once to
   explicitly adopt one. The persisted bootstrap-consumed flag is written before a
   live bootstrap broadcast, so a crash/restart cannot accidentally fund a second
   position. Use --state-file <path> when you intentionally run another independent
   agent for the same wallet/pool.

3. Wallet-wide Meteora inventory:
     slrd meteora positions --all-wallets

   Existing one-wallet command still works:
     slrd meteora positions --wallet pumpfun

4. Close every Meteora position for one wallet, across every pool:
     slrd meteora close-all --wallet pumpfun --all-pools

   Live:
     $env:SOLARD_ENABLE_LIVE_TRADES="1"
     slrd meteora close-all --wallet pumpfun --all-pools --live --continue-on-error

5. Close every Meteora position for every stored signing wallet:
     slrd meteora close-all --all-wallets --all-pools

   Live:
     $env:SOLARD_ENABLE_LIVE_TRADES="1"
     slrd meteora close-all --all-wallets --all-pools --live --continue-on-error

6. Upgradeable program buffer cleanup (all stored signing wallets by default):
     slrd cleanup program-buffers
     slrd cleanup program-buffers --simulate

   Live:
     $env:SOLARD_ENABLE_LIVE_TRADES="1"
     slrd cleanup program-buffers --live

   Limit to selected wallets:
     slrd cleanup program-buffers --wallets pumpfun,phantom

Safety
------
- Meteora close/open/move live writes retain Meteora's two-layer live gate.
- Program-buffer cleanup is plan-only by default; --live additionally requires
  SOLARD_ENABLE_LIVE_TRADES=1 at the CLI.
- Program buffer execution rechecks loader ownership and authority before close.
