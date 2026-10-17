# 5ubru candidate patch review

Chat: 6ad289e5-cbbc-83ec-86ea-c4c600096f26. Candidate marker: SOLARD_5UBRU_END_TO_END_20261017_R1_CORRECTED_DONE.

No candidate code was applied. The patch is retained in the session's current round directory; SHA-256 B93993543837C3E5F78EF234A5F39D9FC6509352CD6780D0F4D2636EFC3BF33C.

## Mainnet routing blocker confirmed

The proposed discoverPumpSwapPool derives all candidates through pumpSwapPoolPda, which always uses the Pump pool-authority PDA as creator. This covers canonical migrated Pump coins but misses ordinary PumpSwap pools with other creators.

Read-only mainnet verification using public RPC returned:

- PUMP mint: pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn.
- PUMP bonding curve absent.
- Actual Global whitelist: USDC EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.
- Proposed candidate set: 16 addresses (WSOL and USDC, indices 0–7).
- Existing accounts in candidate set: zero.
- Real verified PUMP/SOL pool 539m4mVWt6iduB6W8rDGPMarzNCMesuqY5eUTiiYHAgR exists, owner/discriminator/mints/vaults validate.
- That pool creator is 6YUF9bvmbYSVopieXE7boHvByDP9U5ERJoUP6NfcpP9t, not the canonical Pump pool-authority PDA.
- Its live base reserve at capture: 318592434112 PUMP raw; quote reserve: 13855541098 WSOL raw.
- It is outside the proposed candidate set. This is a verified candidate, not a recommendation or proof of best liquidity.

Consequently, the proposed default PUMP discovery still returns null, breaking the required funding/conversion flow. Its synthetic canonical PUMP/SOL fixture cannot prove real PUMP support. Canonical probes remain useful as a fast path, but need a bounded candidate source for noncanonical pools with on-chain validation.

## Patch/integration issues

- git apply --check fails with `corrupt patch at line 366`; hunk counts are inconsistent.
- Recounting also exposes a CHANGELOG context mismatch with a mojibake em dash. The extracted patch field includes the standalone marker after the diff; local extraction can remove the trailer, but the complete diff must have correct counts and source-matching context.
- scripts/verify-5ubru-live.ts accesses `simulation.solChanges`; actual SimulationResult exposes `accountChanges`, so this is an introduced type/API error.
- discoverRouteLookupTables calls Connection.getTransaction with maxSupportedTransactionVersion 1. Existing web3.js 1.98 response validation can reject version 1; raw version-compatible validated lookup extraction must not relabel transactions.
- ALT discovery inspects fundingRoute.legs but not exitRoute.legs, while target pool metadata is added only for buys; protect sells and retain generic shared assembly behavior.
- No local candidate unit tests, typechecks or funded tests were claimed; code was not applied because the routing design demonstrably misses the target's funding asset.

Configured RPC had reached quota; public mainnet RPC served the decisive account reads. No credentials, private keys, signatures or on-chain writes were involved.
