# PRD: WebSocket preflight close race

## Problem

Bun on Windows dispatches close synchronously when the successful preflight closes its socket. The probe rejects its own normal close as a provider rejection.

## Constraints

Keep the SDK API, endpoint derivation, credential redaction, and genuine handshake failure handling unchanged. No dependencies or architecture changes.

## Acceptance Criteria

- [x] Successful open followed by synchronous close resolves readiness.
- [x] Close before open rejects with redacted diagnostics.
- [x] Regression tests pass; repository validation blockers are recorded in TASKS.md.

## Solution Sketch

Settle the successful probe before closing its temporary socket. Exercise public subscribeTrades with mocked WebSocket and HTTP health responses and empty tokens to avoid network subscriptions.

# PRD: Direct trade priority fees

## Problem
Direct buy/sell convenience methods cannot configure priority fees, although transaction builders support them. Transaction receipt status semantics need an explicit explanation.

## Constraints
Preserve default fees, existing confirmation statuses, and pre-submission retry safety. Retain custom fees across the existing buy rebuild.

## Acceptance Criteria
- [x] Direct and multi-wallet buy/sell accept the builder priority-fee options; SDK execution options also accept priorityFee.
- [x] Tests cover defaults, zero values, custom fee propagation and buy rebuild (6 passed).
- [x] Explain submitted/confirmed/failed and confirmation timeout behavior in the core README.

## Solution Sketch
Forward optional priorityFee to each convenience method's builder. Document existing status behavior without changing confirmation or replacement policy.

# PRD: Custom-pair routing patch

## Problem
Two supplied 0.2.27 patches differ in scope. SOL-funded non-SOL PumpSwap pairs require atomic funding and exit legs, and explicit pools must resolve without a Pump bonding curve.

## Constraints
Preserve custom fee options and unresolved-submission safeguards. Do not send live transactions. Do not claim every Meteora venue is covered by PumpSwap changes.

## Acceptance Criteria
- [x] Compare supplied patches and apply the routing patch with required compatibility corrections.
- [x] Verify atomic buy/sell legs, explicit pool routing and mint metadata using offline regressions.
- [x] Run affected tests and report pre-existing failures and unsupported venue gaps.

## Solution Sketch
Use the atomic routing patch as the base, preserve existing fee APIs, and correct explicit-pool resolution using the combined patch's approach. Check the actual installed SDK behavior and retain a clear boundary between verified offline behavior and live pool coverage.

## Outcome
Applied pumpswap-routing.patch with -p4. Adapted explicit-pool resolution, owner/discriminator validation, actual decimals, metadata verification and configured-pool preservation from the combined patch. Second legs use built minimum output rather than a potentially stale quote minimum. Initial patch validation passed 39 distinct tests. The subsequent handoff implementation adds DBC and DAMM v2, verified event identity/supply, accounting and additive migration coverage; see HANDOFF-ACCEPTANCE.md. All-pool coverage and a funded cycle remain unverified. TypeScript checking remains blocked by repository configuration/dependency/source diagnostics. No live transactions were sent.

# PRD: AccountNotFound fee-payer diagnostics

## Problem
MEMAI sell simulation fails before execution with AccountNotFound. Read-only public mainnet RPC confirms the provided token ATA exists but its owner SOL account is absent. Raw simulation output does not identify the fee payer.

## Constraints
Preserve the raw error and program logs. Diagnose only this failure, do not mask RPC uncertainty, and do not broadcast or fund wallets.

## Acceptance Criteria
- [x] AccountNotFound results show compiled fee-payer address and confirmed account existence/balance.
- [x] Submission errors include the diagnostic; missing/existing/unavailable account reads are tested.

## Solution Sketch
Read the compiled fee payer on AccountNotFound, add optional structured diagnostics, and include the diagnostic message in simulation failure reporting. Keep all other simulation behavior unchanged.

# PRD: Shared trade landing policy

## Problem
Native CLI ignores priority fee flags, and ordinary core/SDK trades use a fixed default fee without safe escalation. A confirmed 65,000-lamport receipt proves the requested fee flags were not applied.

## Constraints
Retain atomic routing, fixed-fee API compatibility and simulation diagnostics. Never replace a still-valid or observed transaction; never send a live trade during development.

## Acceptance Criteria
- [x] CLI native buy/sell honors fee and compute flags in simulation and execution.
- [x] Core and SDK share dynamic estimation, bounded expiry-safe retries and attempt reporting.
- [x] Explicit fixed fees remain fixed; uncertainty and program failure stop replacement.
- [x] Relevant regression tests pass (60 tests). Full repository typecheck remains blocked by existing compiler/configuration and source diagnostics.

## Solution Sketch
Integrate the supplied combined patch's trade landing policy separately from its market changes. Preserve priorityFee options, share the kernel with SDK and native CLI, and validate finalized expiry plus history absence before replacement.
