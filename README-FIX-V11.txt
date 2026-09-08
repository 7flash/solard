SOLARD LIQUIDATION + METEORA FIX V11
====================================

This is an overlay patch. Copy these files over the same paths in your Solard checkout.

Changed files
-------------
packages/core/src/chain/liquidation.ts
packages/cli/src/index.ts
examples/meteora-liquidity-agent.ts

LIQUIDATION FIXES
-----------------
1. Jupiter execution amount is recalculated from the wallet's CURRENT associated
   token-account balance immediately before execution. The previous code planned
   from a mint-aggregated balance, which can exceed what Jupiter can debit and
   produce "Insufficient funds".

2. A native Pump/PumpSwap sell that fails at execution can fall back to Jupiter
   using the current ATA balance. This addresses stale/zero-output native routes
   when Jupiter can still execute the token.

3. AccountNotFound during cleanup is idempotent. The account is re-read; if it
   disappeared, cleanup treats it as already completed rather than repeatedly
   failing on every invocation.

4. Token-2022 CloseAccount custom error 0x23 is handled. If close fails because
   the account contains withheld transfer fees, liquidation retries as:

       HarvestWithheldTokensToMint -> CloseAccount

   so empty Token-2022 fee-bearing accounts can actually close.

5. New explicit flag:

       --burn-unsellable

   This is DESTRUCTIVE and is intentionally opt-in. If an UNPROTECTED token has
   no executable native/Jupiter route, only non-ATA stranded balances remain, or
   Jupiter rejects tiny dust (for example a minimum-value/gasless restriction),
   live liquidation burns the residual token balance and then phase 2 closes the
   resulting empty account. Protected --except mints are never included.

   Because this destroys tokens rather than selling them, preview first:

       slrd liquidate tokens `
         --except "slrd" `
         --slippage-bps 1500 `
         --burn-unsellable `
         --simulate

   Then, only if the plan is what you intend:

       slrd liquidate tokens `
         --except "slrd" `
         --slippage-bps 1500 `
         --burn-unsellable `
         --live

   Do NOT use 9500 bps simply to force dust cleanup. 95% slippage does not fix
   zero-output quotes, ATA mismatches, Token-2022 withheld fees, or missing
   accounts; it only permits extremely bad fills when a route does execute.

WHY THE OLD COMMAND KEPT FAILING
--------------------------------
- "PumpSwap SDK sell quote resolves to zero output": tiny/dust balance or no
  economically executable native output. Re-running does not change arithmetic.
- "Insufficient funds": planned mint aggregate can be greater than the balance
  in the ATA the swap transaction actually debits.
- "Minimum $5 for gasless": Jupiter's chosen execution mode rejects the tiny
  order. Re-running the same amount does not change that restriction.
- "AccountNotFound": stale action/account disappeared between scan and simulate.
- Token-2022 custom 0x23: token amount is zero but withheld transfer-fee balance
  still exists in the account; it must be harvested before CloseAccount.
- "unsupported=18": these are nonzero holdings with no supported route. They can
  never become closable by merely re-running normal liquidation. The explicit
  --burn-unsellable mode is the convergence path when you truly want the accounts
  removed and accept destroying those unprotected balances.

METEORA BOOTSTRAP FIX
---------------------
The old dry-run quoted the balancing swap, then passed the hypothetical output
amount into buildOpenPosition even though those output tokens did not yet exist
in the wallet. Meteora's balance-aware compute estimation then correctly failed
with Token-2022 "insufficient funds", after which the agent misleadingly emitted
"would-open".

V11 behavior:
- preview validates the balance-swap quote and target infrastructure;
- it does NOT pretend quoted output tokens already exist;
- final DLMM position construction is deferred in preview;
- live mode executes swap -> reads actual post-swap balance -> builds/opens from
  the observed token inventory.

So your preview should now end with a normal would-open result whose reason says
that final position construction is deferred until the live post-swap balance is
known, rather than printing a simulation stack trace followed by would-open.

VALIDATION
----------
The reconstructed project scan does not include installed node_modules/Bun, so a
full workspace build was not possible in this environment. TypeScript syntax was
checked with tsc; the patched core liquidation file had no diagnostics beyond the
expected unresolved external @solana packages from the dependency-less snapshot.
Install/copy into your real checkout, run `bun install` if needed, then run your
normal workspace typecheck/tests before live execution.
