Solard V34 - sweep only wallets below a native SOL balance ceiling

Adds:
  slrd sweep sol --to <destination> --max-balance-sol <SOL>

Semantics:
- Without --wallets, the existing sweep still considers all stored signing wallets.
- --max-balance-sol 1 selects only wallets with confirmed native balance STRICTLY LESS THAN 1 SOL.
- A wallet with exactly 1.000000000 SOL is skipped.
- Wallets above the ceiling remain in the plan as skipped rows with:
    skippedReason = "balance-at-or-above-max"
- The destination is still excluded automatically.
- Existing --keep / --keep-if-tokens / --keep-if-token behavior is unchanged.
- Default keep is still 0, so an eligible wallet sends balance minus the network fee.

Recommended sequence:

1) Plan only (nothing is signed/submitted):
   bun run .\packages\solard-cli\bin\solard.ts sweep sol `
     --to <destination-wallet-or-address> `
     --max-balance-sol 1 `
     --show-skipped

2) Simulate selected wallets:
   bun run .\packages\solard-cli\bin\solard.ts sweep sol `
     --to <destination-wallet-or-address> `
     --max-balance-sol 1 `
     --simulate

3) Live sweep:
   bun run .\packages\solard-cli\bin\solard.ts sweep sol `
     --to <destination-wallet-or-address> `
     --max-balance-sol 1 `
     --live

If your checkout uses packages/cli instead of packages/solard-cli, run the equivalent CLI path. The apply script detects either source layout.
