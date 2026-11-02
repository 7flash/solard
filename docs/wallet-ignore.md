# Ignored wallets

Ignored wallets are retained in the same database with their encrypted keys,
history and group memberships. The existing `isActive=0` state is used; there
is no schema change or wallet-table migration.

```sh
slrd wallet ignore <wallet>
slrd wallet unignore <wallet>
slrd wallets --ignored-only --addresses-only
slrd wallets --include-ignored --addresses-only
slrd wallets --ignore-zero
```

Default wallet listing, portfolio, liquidation and sweep selection skip ignored
wallets before RPC calls. Automatic group selection skips them too. Explicit
wallet access remains available, including signing and `balances --wallet`;
ignoring is a selection preference, not a security lock or deletion.

`--ignore-zero` checks active wallets in batches of at most 100 account reads,
then marks exact zero-SOL wallets ignored. An absent account is zero; a failed
or truncated RPC response aborts before any wallet is changed. No token-account
reads, transfers, sales or burns occur. A zero-SOL wallet can still own tokens
or reclaimable token-account rent. Funding an ignored wallet does not restore
it automatically: use `wallet unignore`. Re-importing a wallet also restores it.

The CLI prints the checked count, retained count and public ignored-wallet
addresses, names and observed slots, so the change can be reviewed or reversed.
