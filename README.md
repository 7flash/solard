# slrd spam-buy safe v1

Priority patch for `packages/core/src/launches/pump/spam-buy.ts`.

## What it changes

- Exactly one live signed transaction generation per wallet.
- Pending transaction => resend identical signed bytes only.
- `processed` => never create a replacement generation.
- New quote/blockhash generation only after explicit transaction failure or blockhash expiry before processing.
- Only `confirmed`/`finalized` counts as command success; `processed` no longer gets mislabeled confirmed.
- Resend transport errors do not trigger a new transaction generation.
- Removes the redundant `refreshToken()` call in every buyer immediately after shared market discovery.
- Keeps the current `slrd spam-buy <mint> --group ... --sol ...` CLI syntax unchanged.

## Apply

```powershell
Expand-Archive .\slrd-spam-buy-safe-v1.zip -DestinationPath .\_slrd-spam-safe -Force
.\_slrd-spam-safe\slrd-spam-buy-safe-v1\apply.ps1 -Repo C:\Code\solwal
```

Then run the repository's normal typecheck/build.

## Safety invariant

A pending transaction is never replaced just because a recompile/fresh-quote timer elapsed. The same signed bytes are resent until it confirms, explicitly fails, or its blockhash expires before any processed observation.

Once any node reports `processed`, the command prioritizes no-double-buy safety and will not construct another buy generation for that wallet.
