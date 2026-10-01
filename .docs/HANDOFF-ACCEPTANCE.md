# Solard handoff acceptance — 2026-10-06

Implemented in the working checkout; no release or live trade was submitted.
The checkout's existing package versions are 0.2.29 and were preserved.

## Behavior

- PumpSwap events are attributed only after the event pool's base mint matches
  the subscription. Quote identity/decimals and supply are read from verified
  accounts. An unrelated pool cannot update watched-token price or supply.
- Token inspection/refresh verify mint owners and vault identities, including
  Token-2022 PUMP quote accounts. Empty, closed bonding-curve accounts do not
  prevent discovery of standalone AMM markets.
- SOL-funded custom pairs compose funding and target swaps atomically. The
  second leg spends the first leg's guaranteed minimum, not existing unrelated
  quote holdings. Excess intermediate output can remain. Slippage is divided
  between both legs; transaction size and lookup-table constraints still apply.
- Converted SOL/USD prices are unavailable when no verified conversion exists.
  Supply is refreshed on active events and decoded event supply is not trusted.
- DBC and DAMM v2 discovery, swap construction and event decoding are installed
  in the trader preset. THICC's reported DBC pool is now migrated; active SOL
  DAMM v2 pool: `4CmPy9CYhVpTTEE1dWLt4ezHgn8Y3niJj9CtUQkDLstb`.
- Confirmed accounting separates SOL principal, network fees and target-token
  deltas, including ATA rent adjustments. Pre-submission errors expose their
  phase; submitted-but-unconfirmed transactions remain uncertain.
- Native additive SQLite migrations are available and tested with populated
  rows/triggers and an ORM reopen. The default ORM synchronizer still compares
  schema SQL and can rename/recreate incompatible tables. This is documented.

## Verification

Full repository test command: `npm test` — 195 passed, zero failed (52 files).
Fixtures contain public mainnet accounts frozen at slot 453849663. Regressions
cover mismatched pools, verified supply/capitalization and strategy callback,
unavailable conversions, quote programs, DBC/DAMM SDK instructions, atomic
minimum amounts, confirmed accounting and additive migration reopening.

Unsigned mainnet simulations used 0.001 SOL, 500 bps total slippage, a 600,000
CU limit and 200,000 micro-lamports/CU. Signature verification was disabled;
the harness has only a public payer and cannot sign. All three returned no
simulation error:

| Target | Route | Compute consumed | Serialized size |
| --- | --- | ---: | ---: |
| Pillson | SOL → PUMP → Pillson | 234,508 | 836 bytes |
| Nut | SOL → PUMP → Nut | 238,994 | 1,019 bytes |
| THICC | SOL → THICC, DAMM v2 | 45,495 | 695 bytes |

The PumpSwap simulations used existing, read-only public address lookup tables;
no tables were registered in the user's database. Without suitable tables these
two-leg transactions exceed the packet limit. The harness is
`handoff-simulation.ts`; read-only metadata inspection is `handoff-readonly.ts`.

## Remaining acceptance

- A funded, confirmed buy/sell cycle is not performed. Public-account unsigned
  simulations and accounting fixtures do not establish a real confirmed fill.
  Wallet, cluster, token/pool and budget are still needed before transaction
  review and explicit signing/submission approval.
- DAMM v1, ordinary DLMM swaps and transfer-hook DBC pools are outside these
  venue integrations. Do not advertise every Meteora pool as supported.
- Full TypeScript checking remains blocked by repository compiler configuration,
  missing Node types, removed runtime exports and existing dependency/type
  mismatches. TypeScript 5.8 reaches source checking; the new DBC/DAMM modules
  produce no source diagnostics. Test execution is green.
- Historical capitalization claims and the historical AlterLife fill were not
  independently replayed; regression tests establish the identity/supply rules,
  not historical market values. Application identity/strategy guards stay intact.
