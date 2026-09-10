Solard position controller V32 - fresh pre-submit revalidation

Based directly on V31 no-dashboard position-controller.ts.

What changed
- Keeps normal built-in measure-fn streaming. No terminal dashboard and no custom JSON logger.
- A BUY decision is revalidated from a fresh wallet/liquidation snapshot immediately before sizing.
- Non-flat buys must still be below the lower value band AND still satisfy the current
  post-sell retracement or lower-ladder price guard.
- Flat pullback entries are checked again after sizing, immediately before the final execution quote.
- The final exact-input BUY quote is itself price-guarded before submission. Raydium uses
  its explicit minOutputRaw; Jupiter uses the controller slippage budget as a conservative floor.
- A SELL decision is revalidated from a fresh full-position liquidation snapshot before sizing.
- Post-buy sells must still satisfy the take-profit price on the final executable sell quote.
- If the market reverses while route discovery/sizing is running, the controller logs
  trade.buy.pre-submit-hold / trade.sell.pre-submit-hold and submits nothing.
- V29/V30 settlement proof, transaction-local economics, and V31 cycle resilience remain unchanged.

New measure labels
  snapshot.pre-submit-buy
  trade.buy.pre-submit
  trade.buy.pre-submit-hold
  snapshot.pre-submit-sell
  trade.sell.pre-submit
  trade.sell.pre-submit-hold

No new flags. Existing --slippage-bps also acts as the conservative Jupiter pre-submit
price guard because Jupiter Swap V2 does not expose an explicit min-output field here.
