Solard value-band controller V30 — transaction-local SOL economics

Basis
-----
Built directly on V29 and the user's no-dashboard, normal-measure-fn controller.
No terminal dashboard, custom logger, JSONL audit stream, or strategy threshold changes.

Changes
-------
1. Settlement accounting is transaction-local for BOTH buys and sells.
   The journal no longer uses requested input as settled buy cost or a later wallet
   SOL snapshot as settled proceeds.

2. Derives one SOL-like economic delta from confirmed transaction metadata:
     owner native lamport delta
     + network fee added back when this wallet is the fee payer
     + lamport deltas of wallet-owned SPL token accounts

   Folding wallet-owned token-account lamports into the calculation prevents
   recoverable ATA rent creation/closure from being mistaken for trading P&L and
   naturally includes an existing WSOL account's principal changes.

3. BUY settlement:
     actual economic SOL spent = -transaction economic delta
     actual tokens received     = postTokenRaw - preTokenRaw
     buy execution anchor       = economic SOL spent / tokens received

4. SELL settlement:
     actual economic SOL received = +transaction economic delta
     actual tokens sold           = preTokenRaw - postTokenRaw
     sell execution anchor         = economic SOL received / tokens sold

5. Network fee remains visible but is excluded from strategy capital accounting.
   External/platform transfers that are real economic loss remain part of the
   transaction economic delta.

6. measure-fn output adds these fields to settlement.settled:
     economicSolDelta
     networkFeeSol
     ownerNativeDeltaSol
     ownedTokenAccountLamportDeltaSol
     cumulativeBuySol
     cumulativeSellSol
     netCapitalSol

The V29 settlement barrier remains: tx meta must prove success + token delta, and
live token indexing must match the proven post-trade token amount before another
trade can run.
