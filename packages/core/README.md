# @solard/core

Canonical Solard implementation: encrypted wallet persistence, SQLite repositories, Solana transaction composition/sending, token venues, Pump launch/trading support, groups, agents, watches and ALTs.

Applications should normally import `@solard/sdk`. The CLI and SDK share this package and therefore share the same database and behavior.

```ts
import { Solard } from "@solard/core";

const slrd = new Solard({ dbPath: "./slrd.db" });
const wallet = slrd.createWallet("alpha");
console.log(wallet.address);
```

`SLRD_MASTER_KEY` is required when wallet secret material must be encrypted/decrypted.

## Trade priority fees and confirmation

Direct `buy`, `sell`, `buyMany`, and `sellMany` accept the same priority-fee
settings as the transaction builder:

```ts
const priorityFee = { cuLimit: 600_000, microLamports: 200_000 };
const receipt = await slrd.buy(token, wallet, { sol: 0.1 }, { priorityFee });
await slrd.sell(token, wallet, { priorityFee, bps: 10_000 });
```

`microLamports` is the price per compute unit. An explicit price stays fixed;
zero disables the priority fee. Without a price, ordinary trades estimate the
75th percentile of recent fees for writable accounts, with a 100,000
micro-lamports/CU floor and a 1,000,000-lamport priority-fee cap. The default
compute limit remains 600,000. Configure automatic selection with
`landing: { feePercentile: 90, maxAttempts: 3, maxPriorityFeeLamports: 1_000_000 }`.

Receipts report `submitted`, `confirmed`, or `failed`. `submitted` means the
transaction has been submitted or attempted but confirmation remains unresolved;
it does not prove that an RPC has observed it. Each attempt waits up to three
minutes for reconciliation, then returns `submitted` if still unresolved.
Use `slrd.confirmSignature(receipt.signature)` to check again. Confirmed and
finalized cluster statuses both map to `confirmed`; processed transactions stay
pending. Confirmation uses a WebSocket subscription with 2.5-second polling.

With `@solard/sdk`, pass `priorityFee` in the second argument:

```ts
await sdk.buy(
  { token, wallet, amount: 0.1 },
  { priorityFee, waitForConfirmation: false },
);
```

Convenience `waitForConfirmation: false` returns `unresolved` with a signature and
execution ID after submission. By default the SDK waits for confirmation or
blockhash expiry, checking once more after expiry before reporting failure.
Transport errors can leave submission unresolved, so a pending receipt is not a
reason to place another trade. Automatic fees double between attempts, up to
the cap, only after finalized blockhash expiry and healthy history checks find
no transaction. Any observed transaction, program failure, or ambiguous RPC
result prevents replacement. At most three attempts run by default; receipts
include the attempted signatures and selected prices. Fixed prices stay fixed.

Native CLI buy/sell accepts `--cu-limit`, `--priority-micro-lamports` (fixed price),
`--fee-percentile`, `--trade-attempts`, `--fee-multiplier`, and
`--max-priority-fee-lamports`. Simulation uses the same fee selection.
This automatic policy covers ordinary direct trades and non-bundle multi-wallet
trades. Jupiter routing, group builder methods, and bundle submissions retain
their existing execution policies.

## Custom PumpSwap pairs

Register an explicit pool when the token uses a standalone/custom PumpSwap market:

```ts
await slrd.addToken(mint, undefined, { venueHint: "pumpswap", pool: poolAddress });
await slrd.buy(mint, wallet, { sol: 0.1 });
await slrd.sell(mint, wallet);
```

Pool identity, program owner, discriminator, vault mints, and mint token programs
are checked. Explicit pools do not require a Pump bonding curve; token refresh
preserves the configured pool. Mint decimals come from account reads.

When a market is quoted in another token, a SOL-funded buy builds the funding
leg and target buy in one transaction. A sell builds the target sale and exit to
SOL in one transaction. The quote token must itself have a supported SOL market.
Each second leg spends only the first leg's protected minimum; extra intermediate
tokens may remain in the wallet. The slippage budget is split between the legs.
Routes must fit the transaction limits and pass simulation.

## Unified programmatic trades (0.2.30)

Use `createTraderSolard()` for the installed venue preset. Native routes are tried
first; otherwise Jupiter quote/swap-instructions are composed into the same plan.
The caller submits through their configured RPC, with their CU limit and price.
Jupiter-supplied lookup tables are read automatically. Oversized native routes
throw before signing with account candidates for an appropriate lookup table;
Solard does not create or fund tables implicitly.

```ts
const result = await slrd.sell(token, wallet, {
  bps: 1_000, slippageBps: 500, minOutputLamports: 100_000n,
  intentKey: "I-0101:SELL:42",
  landing: { maxFeeBpsOfNotional: 500, maxPriorityFeeLamports: 100_000 },
  via: ["rpc", "helius"],
});
// confirmed / failed / unresolved; phase, code, message, attempts and deltas.
const settled = await slrd.resumeTrade("I-0101:SELL:42");
```

Buy uses `minOutputRaw`. A BELOW_MINIMUM error includes quoted/required minima.
Low-level composer build/simulation errors remain typed pre-submission errors;
the convenience API returns failures as structured results. Low-level submission
receipts retain `submitted`, mapped to `unresolved` by convenience methods.
Confirmed accounting fields are null when metadata is unavailable, never invented.

Intent keys are stored in the existing settings table with unique keys. Reusing
a key for another trade returns INTENT_CONFLICT. Every signed generation is
journaled before broadcasting. Resume observes original signatures and uses
finalized expiry/history absence checks; it never places a new trade. An intent
reserved before any signature exists stays unresolved and needs manual recovery.
Use a new key only after resolving the previous intent. Keep workers on the same
database. Convenience trades/transfers serialize per wallet in one process;
callers must serialize low-level plans and cross-process operations with different
intent keys. Whole wallet exit flows also need caller ownership of that wallet.

Hooks: `onAttempt`, `onSubmitted`, `onRebroadcast`, `onSettled`. Sender fallback
and rebroadcast retain the same signed transaction; replacement fees increase
only after proven expiry. Relative caps reserve an estimated signature base fee
before allocating compute priority fees; tips and account rent are excluded.
Fixed prices exceeding a cap fail before sending.

CLI `transfer` also uses automatic fees and bounded expiry-safe settlement.
An explicit `--priority-micro-lamports 0` disables its priority fee. Output
`feeEstimate` identifies the CU limit, selected price and estimated charges;
`feeLamports` is populated only when a confirmed charge is available. Execution
metadata retains the original blockhash/expiry height for reconciliation.

`quote({ side, token, wallet, amount, bps, slippageBps })` materializes instructions
without signing and returns expected/protected output and estimated network fees.
`curveLiquidity(token)` exposes verified real/virtual reserves, quote identity and
completion. `transferToken(wallet, mint, destination, "all")` bypasses trade routing,
including non-associated accounts. `maxSendableSol` estimates spendable SOL after
fees and an optional reserve; `exitWallet` reports sells/transfers/withdrawal and
stops on unresolved execution. Transfer restrictions/extensions can still fail.

Live prices are available for Pump curve, PumpSwap, Raydium LaunchLab, Meteora DBC
and DAMM v2. Jupiter-routed Raydium AMM/CPMM trades have no verified live pool
price stream here. Do not claim those markets are ready for a live-price strategy.
`JUPITER_SWAP_API_URL` and optional `JUPITER_API_KEY` configure instruction routing;
`JUPITER_DEXES` optionally restricts labels. No available aggregator route produces
a typed NO_ROUTE failure; routing does not guarantee every LaunchLab token.

This support applies to PumpSwap protocol pools, including custom pairs exposed
by another frontend. It does not establish support for another frontend's distinct
programs or every Meteora pool type.

## Meteora and verified prices

The trader preset used by the CLI and SDK installs Meteora DBC and DAMM v2
venues. Discovery follows migrated DBC tokens to their active DAMM v2 pools.
These integrations support ordinary exact-input swaps; DAMM v1, DLMM and
transfer-hook DBC pools are not covered. Explicit pool registration is available
with `venueHint: "meteora-dbc"` or `"meteora-damm-v2"`.

Listeners verify each event's pool identity, mint programs and decimals before
attributing it to a watched token. Capitalization uses chain-verified supply.
Non-SOL quote prices require a verified conversion; unavailable SOL/USD price
fields remain null. Applications must not trade on unavailable prices.

Unsigned mainnet simulations passed for Pillson and Nut SOL-funded atomic buys
and THICC's current DAMM v2 buy. The atomic PumpSwap routes require suitable
address lookup tables to fit transaction limits. A funded buy/sell cycle has
not been performed; simulated acceptance does not establish a confirmed fill.

## Additive SQLite migrations

The installed sqlite-zod-orm schema synchronizer can rename a populated table
and create an empty replacement when generated CREATE TABLE SQL changes.
Adding a defaulted field is not automatically a row-preserving migration.
Before opening the ORM with the changed schema, an appended numeric column can
be migrated explicitly:

```ts
ensureAdditiveSqliteColumns(dbPath, "trades", [
  { name: "snapshot", definition: "INTEGER", backfill: 0 },
]);
// Append snapshot: z.number().default(0) to the existing ORM schema.
```

Native ALTER TABLE preserves existing rows and triggers. The resulting column
order and SQL definitions must match the ORM's generated schema; this helper
does not disable subsequent ORM schema synchronization. Test reopening a copy
of production data before changing its schema.
