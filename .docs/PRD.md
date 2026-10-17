# PRD: 0.2.34 custom quote and packaging repair

## Problem
SEEDCAT receives logs but cannot construct live markets when web3.js rejects version-1 parsed transactions. Mements reported a missing core history-recorder export in its 0.2.33 installation. The currently downloaded registry core archive contains that export; fresh installation additionally exposed a missing SDK trader-factory export and core's undeclared measurement runtime dependency.

## Constraints
Preserve event reserves, verified mint supply/decimals, app guards, and honest unavailable prices. No transaction version relabelling. Bound conversion recursion and respect Pump quote eligibility. Validate unsigned plans without funded transactions. Publish matching packages only after tests and archive validation.

## Acceptance Criteria
- [x] Validated version-1 parsed responses retain version 1.
- [x] Custom quote metadata survives unavailable transaction enrichment.
- [x] SEEDCAT quote SOL pool and eligible unmigrated quotes yield usable supply-based prices without Jupiter (historical event replay with current quote reserves; fresh tick acceptance remains open).
- [x] Conversion failures distinguish unavailable conversion from unsupported metadata.
- [x] Buy/sell instruction plans preserve quote programs, buyback ATAs, leg minima and aggregate SOL guards; SEEDCAT requires ALTs before simulation/execution.
- [x] Fresh Bun installation of packed SDK/core imports createTraderSolard and passes readiness tests.
- [ ] Fresh live SEEDCAT tick (historical replay passes; 45-second observation saw no tick).
- [ ] Matching fixed packages published and fresh registry archives checked.

## Solution Sketch
Extend existing transport and market metadata loaders, validate curve and mint accounts, and reuse bounded verified conversion paths. Repair public exports and test the npm archives rather than relying on workspace typechecking. Record funded acceptance gaps explicitly.
