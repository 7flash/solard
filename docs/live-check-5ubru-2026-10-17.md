# Live SDK check: 5ubru, 2026-10-17

Mint: `5ubruMYpgKqw9ip5J1qrXbVGmMdn2VCsMg421B4bpump`.
Checked the local SDK workspace, whose package manifest reports 0.2.37, against mainnet. No private keys were read, transactions signed, or transactions submitted. Existing repository changes were preserved.

## Verified market

- PumpSwap pool: `DBzf8tQ3mTLSdGMLcDj1YA7E8HqAtq22JaFqma92Fi4`.
- Quote mint: `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn` (PUMP).
- Both mints have six decimals and use Token-2022.
- Chain supply at capture: 975357022505512 raw units.

## Live listener

SDK `listenTrades` received 368 events during a 25-second observation, with correct watched mint and PUMP quote identity. SOL/USD prices and USD market capitalization were unavailable. The listener reported `quote-sol-conversion-unavailable`. Subscription delivery alone does not prove usable converted prices.

## Execution checks

The default SDK composer failed during funding-token discovery: the configured RPC rejected a PumpSwap `getProgramAccounts` query with "Too many accounts requested (10000001 pubkeys)" and requested paginated discovery.

For a diagnostic bypass, the temporary SDK token repository was populated with explicit pool metadata verified from chain accounts. The PUMP/SOL pool candidate was `539m4mVWt6iduB6W8rDGPMarzNCMesuqY5eUTiiYHAgR`; it was a discovered candidate, not a claim of the best available execution pool. This bypass is not evidence that default discovery works.

The composer then constructed buy and sell instructions. At capture, a 0.001 SOL buy with 500 BPS total slippage protected 106002843 target raw units (106.002843 tokens), and selling that hypothetical amount protected 883266 lamports. Sell construction used a hypothetical balance rather than a funded wallet position. These quotes change with reserves.

The unsigned buy and combined buy/sell messages failed serialization with `RangeError: encoding overruns Uint8Array`. No suitable lookup tables were supplied by the route or found in the sampled target-pool transaction. Simulation could not run, so executable/funded acceptance remains unverified.

## Remaining work

1. Avoid the provider-rejected discovery scan for funding tokens.
2. Restore a verified PUMP conversion route for live SOL/USD prices.
3. Supply suitable lookup tables or a smaller atomic route, then simulate again.
4. Only after simulation succeeds, review a concrete funded transaction with the user.

Sanitized diagnostic output is retained locally under `.solard/verification/2026-10-17/`.

## Candidate integrated repair — unverified pending Codex

Discovery now uses canonical PDAs plus bounded activity-account candidates for
noncanonical pools. PUMP has no curve and is not Global-listed; its verified
WSOL pool must be found through bounded activity, with owner/discriminator/mint
and vault validation. An observed candidate is not proof of best execution.

Acceptance order: run focused PumpSwap, ALT and SDK tests, npm test and
typechecks; run the opt-in read-only harness with a public funded payer; verify
fresh converted events, serialized v0 size and successful simulation logs.
If no ALT compresses the route, review separate ALT creation/extension and
activation before re-quoting/simulating. A real buy is prohibited until user
wallet/amount approval and a reviewed passing simulation. Funded acceptance
requires a confirmed signature and verified SOL/token/network-fee changes.

## Local integration results

The complete R2 inline patch was applied after restoring diff formatting lost during chat capture. A small integration fix restored the `curve` variable still used by PumpSwap pool/quote identity validation. Existing unrelated changes were preserved, with preimages saved outside the workspace.

- Baseline: 336 tests passed. After integration: 342 tests passed, 1,404 assertions across 98 files.
- Focused discovery, unsigned preparation, ALT, existing pool, market and SDK checks: 50 passed, 252 assertions.
- Core and SDK typechecks still fail with their existing diagnostics. Comparing diagnostic path/code/message before and after integration found no new errors (213 core and 131 SDK diagnostic records).
- Public Solana RPC mainnet acceptance emitted the correct market identity but hit HTTP 429 repeatedly and produced no converted event within the observation window.
- A second provider with the mainnet genesis hash also produced no converted event within 60 seconds. A direct discovery probe made 26 parsed transaction calls, then was blocked with HTTP 403 / JSON-RPC -32602 `Request blocked` during subsequent account reads.
- A separate public SDK `simulateUnsignedBuy` call, limited to two requests per window and with retries disabled, failed after 31 seconds with the same provider HTTP 403. It did not reach successful buy simulation.

Live price-to-buy acceptance remains open. No private keys were read, messages signed, ALT accounts created, packages published, or transactions submitted. A passing deterministic suite does not establish this token can yet be bought through the default path on the tested providers.

## R3 acceptance instrumentation (pending local validation)

The candidate checks small canonical groups before reading history, validates
noncanonical mint-activity candidates incrementally, and retains positive pool
identity for five minutes. Execution and listener connections still have separate
per-connection caches; provider 403/429 responses are reported as provider
unavailability, not proof that a pool is missing. The read-only harness reports
market, unsigned build/simulation, and feed independently. A successful signed
buy remains unverified pending RPC quota, active ALT availability, successful
simulation, and explicit funded-wallet approval.

R3 integration checks passed: 344 tests and 1,409 assertions across 98 files; focused checks passed 50 tests. Core/SDK typecheck diagnostic sets remain unchanged from baseline. Mainnet acceptance still failed: the configured RPC answered a slot query but rejected account reads with HTTP 429 `max usage reached`. The staged harness reported market UNKNOWN_TOKEN, buy RPC_PROVIDER_UNAVAILABLE, and no successful feed acceptance. Slot readiness alone does not prove account/history quota is available. No transaction was signed or sent.

The requested scope also includes custom-quote Pump launches with an atomic SOL-funded creator buy, followed by live converted prices and SDK buy/sell. Launch APIs already exist, but this expanded live acceptance has not been completed.
