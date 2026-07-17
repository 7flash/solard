# Solard Airdrops page v3 — authoritative server preview and execution

This patch adds `/airdrops`. Solard is the executor: the browser never sends a
private key and there is no external executor URL or wallet service.

## What changed from v2

The browser no longer supplies the final recipient ledger or payout decimals.
It submits distribution rules only. The server then:

1. refreshes holders through the existing `getTerminalHoldersAction`,
2. reads source and payout mint decimals on-chain,
3. filters the authoritative holder snapshot,
4. calculates exact raw-token allocations with `bigint`,
5. returns an immutable preview `planId`, and
6. rebuilds the plan immediately before execution.

Live execution is rejected with HTTP 409 when the holder balances, rules, mint
decimals, or resulting allocations no longer match the preview.

## Server execution flow

1. `POST /api/airdrops/distribute` with `action: "preview"` returns the exact plan.
2. The user reviews the recipients and types `AIRDROP`.
3. `POST /api/airdrops/distribute` with `action: "execute"` includes the preview ID.
4. A persistent job is created under `.solard/airdrop-jobs`.
5. The long-running Solard server resolves the selected managed wallet and signs
   SPL Token or Token-2022 transfers.
6. The frontend polls the job and displays batches, recipients, signatures,
   failures, cancellation, and confirmation-uncertain states.

## Allocation behavior

- **Fixed:** exact amount per eligible holder.
- **Equal total:** integer raw units are divided equally; remainder units are
  assigned deterministically so the declared total is exact.
- **Pro-rata:** uses holder raw balances and a largest-remainder allocation, so
  every raw payout unit is accounted for without JavaScript floating-point loss.

The plan is rejected when the total is too small to allocate at least one raw
payout unit to every selected recipient.

## Apply

Copy these folders into the repository:

- `app/airdrops`
- `app/api/airdrops`
- `src/solard/airdrops`

Then apply `navigation.patch` from the repository root.

Install the SPL Token client if the repository does not already include it:

```bash
bun add @solana/spl-token
```

Optional settings:

```bash
SOLARD_AIRDROP_BATCH_SIZE=5
SOLARD_AIRDROP_JOB_DIR=.solard/airdrop-jobs
```

The batch-size range is clamped to 1–10. Five is the conservative default.

## Managed-wallet integration

`src/solard/airdrops/runtime.ts` opens its own `createSolardActionContext()` for
the lifetime of the background job. It does not retain the request-scoped
`withSowl` instance after the HTTP response.

The supplied project scan contains the web routes but not the implementation of
`src/solard/actions` or the encrypted wallet repository. Because of that,
`runtime.ts` includes a compatibility resolver for common internal signer and
wallet-store method names. It validates that the resulting signer public key is
exactly the bank wallet selected in the frontend.

When the actual encrypted store uses a different method, replace only
`resolveSigner()` with the repository's direct internal lookup. Everything else
is already server-side and does not require a separate service.

## Safety behavior

- Live execution requires typing `AIRDROP`.
- The live request must match an authoritative server preview ID.
- Mint ownership and decimals are verified on-chain.
- Bank SPL balance and SOL fee balance are checked before sending.
- The selected bank is excluded from recipients.
- Recipient ATAs are created idempotently when needed.
- Failed multi-recipient batches fall back to individual transactions.
- Once a signature has been submitted, an uncertain confirmation stops the run
  in `attention` state instead of retrying and risking duplicate transfers.
- Cancellation takes effect between transactions.
- Confirmed, partial, cancelled, and attention jobs are idempotent and are not
  silently replayed as full airdrops.
- A server restart marks in-flight work for manual review rather than resuming
  transfers blindly.

## Validation performed

The patch was checked with TypeScript 5.8 using project-shaped module stubs. The
page, API route, planner, job store, runtime adapter, and executor pass the
strict no-emit type check.
