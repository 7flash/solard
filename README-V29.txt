Solard value-band controller V29 — measured settlement barrier

Basis
-----
This patch is based directly on the user's no-dashboard position-controller.ts.
It does not restore the terminal dashboard or add a custom logger/audit stream.

Changes
-------
1. Enables Solard/measure-fn's normal built-in renderer in the child script:
     configureSolardMeasure({ silent: false })

2. Restores a hard post-swap settlement barrier.
   A submitted buy/sell is persisted as pending before accounting is committed.
   No later trade may run until:
     - getTransaction(signature) is available at confirmed commitment,
     - tx.meta.err is null,
     - the wallet token delta has the expected sign,
     - the live token-account index matches the post-transaction amount.

3. Execution-price anchors are derived from settled economics:
   - BUY anchor = requested SOL principal / actual wallet tokens received.
   - SELL anchor = actual proven SOL/WSOL proceeds / actual wallet tokens sold.
   Quotes are retained for diagnostics only; they are not used as settled accounting.

4. Restart safety.
   pendingSettlement is stored in the existing journal. On restart the controller
   reconciles it before taking a new decision. If RPC/token indexing is behind,
   the cycle returns HOLD and trading remains blocked.

5. measure-fn-only observability.
   Added normal spans/annotations:
     settlement.pending
     settlement.reconcile.buy / settlement.reconcile.sell
     settlement.wait-wallet-index
     settlement.settled
     trade.buy.blocked / trade.sell.blocked

No strategy thresholds, sizing modes, routing policy, entry-pullback behavior, or
terminal dashboard are introduced/changed by this patch.
