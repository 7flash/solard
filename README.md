# Solard Airdrops page patch

This patch adds an `/airdrops` console page with:

- holder tracking through the existing `/api/token-holders` endpoint;
- 30-second optional refresh and per-holder balance deltas;
- minimum balance/share filters and address exclusions;
- a bank profile backed by an existing managed wallet;
- fixed, equal-total, and pro-rata payout planning;
- CSV export and server-side plan validation;
- guarded live execution through a server-only executor URL.

## Apply

1. Copy `app/airdrops` and `app/api/airdrops` into the project.
2. Apply `navigation.patch` from the repository root.
3. Configure the signing service only when live transfers are ready:

```bash
SOLARD_AIRDROP_EXECUTOR_URL=https://internal-wallet-service.example/airdrops
SOLARD_AIRDROP_EXECUTOR_TOKEN=...
```

The executor receives a `solard.airdrop-plan` JSON payload and must create the recipient token accounts when needed, perform checked SPL-token transfers from the selected bank wallet, and return transaction signatures/statuses. Keep that service private and idempotent.

Without `SOLARD_AIRDROP_EXECUTOR_URL`, holder tracking, planning, CSV export, and validation work; live execution returns HTTP 501 instead of risking an unsigned or partially implemented transfer path.
