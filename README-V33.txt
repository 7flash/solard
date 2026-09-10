Solard position controller V33 — executable-order guard

Purpose
-------
V32 rechecked a fresh quote before submission, but both execution paths could
still fetch/build a NEW order after that check:

- Jupiter executeJupiterSwap() fetches /order again with the taker before signing.
- Raydium buildSwapExactIn() fetches a fresh quote while building the transaction.

On a fast token, the checked quote could be acceptable while the actually signed
order had already moved through the strategy price guard.

V33 binds the strategy guard to the fresh executable order.

Changes
-------
1. Jupiter executeJupiterSwap accepts optional minOutputRaw. The taker-specific
   /order response is rejected BEFORE transaction deserialization/signing when
   its outAmount is below the required threshold.
2. Raydium checks the freshly rebuilt prepared.quote.minOutputRaw BEFORE
   executePrepared(). If it no longer protects the strategy minimum, no
   transaction is submitted.
3. Lower ladder / post-sell rebuy guards are converted to minimum raw token
   output and passed into the execution path.
4. Post-buy take-profit guards are converted to minimum raw SOL output and
   passed into the execution path.
5. Flat-entry pullback gets the same order-bound protection; it can no longer
   pass a probe and then sign a materially worse fresh order.
6. Manual --scale-now remains intentionally unguarded by strategy price anchors;
   it is an explicit operator action. Settlement and accounting safety still
   apply.

Observability
-------------
No dashboard/custom logger was added. Existing normal measure-fn output remains.
Relevant spans/notes include:
  trade.buy.pre-submit
  trade.buy.pre-submit.flat
  swap.buy.jupiter / swap.buy.raydium
  trade.sell.pre-submit
  swap.sell.jupiter / swap.sell.raydium

If the fresh executable order violates the guard, the swap span errors BEFORE
submission/signing and V31 treats it as a pre-submission cycle failure, so it can
retry from a fresh cycle rather than duplicate a transaction.

Files
-----
examples/position-controller.ts
packages/core/src/chain/jupiter-swap.ts

Apply
-----
  .\apply-v33.ps1 -Repo C:\Code\solwal

Then restart the same position-controller command.
