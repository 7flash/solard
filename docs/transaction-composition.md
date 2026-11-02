# Composing transactions

The SDK exposes the existing core composer. A known fixed transfer can follow a fee claim in the same transaction:

```ts
import { createSolard, sol } from '@solard/sdk';
const sdk = createSolard({ rpcUrl });
const tx = sdk.tx(wallet)
  .claimFees(token)
  .transferSol(recipient, sol('0.01'));
const plan = await tx.build();
const simulation = await sdk.simulatePlan(plan);
// Inspect the simulation before a separately authorized tx.send({ via: 'rpc' }).
```

Instructions execute in call order, including custom `.add()` and `.addMany()` instructions after async operations. Concurrent builds materialize once; adding operations after a build starts is rejected. A fixed transfer means exactly that amount, not all claim proceeds. Existing balance/rent checks remain conservative; no estimated claim is silently treated as guaranteed incoming SOL.

For multiple prepared operations, `composeTransactionDrafts(parts, options)` preserves instruction order, actions and minima, co-signers and tracked accounts. It returns a new draft without quoting, signing or sending. Default CU limits sum the parts and cannot exceed 1,400,000; set an explicit group limit when needed and verify it by simulation. No operation is dropped or automatically split.

Compile several explicit groups with one blockhash generation:

```ts
const plans = await sdk.compileGroups([
  { payer: 'creator', drafts: [deploymentDraft, creatorBuyDraft], cuLimit: 1_400_000 },
  {
    payer: 'buyer1', additionalWallets: ['buyer2', 'buyer3'],
    drafts: [buy1Draft, buy2Draft, buy3Draft], cuLimit: 1_000_000,
  },
]);
```

Every required wallet signer must be declared. Missing signers fail before lifetime capture/signing. All groups share the same pinned blockhash even if building takes longer than the cache TTL. Existing packet/account/instruction guards run during compilation. This method signs prepared plans but never submits them.

`sendBatchPlans` retains core semantics: RPC batches are independent sends; Jito groups at most five transactions per bundle. A list longer than five is not one atomic operation. Dependent deployment/buy groups require joint bundle simulation; simulating each transaction separately cannot establish that later transactions can use a newly created mint. The current Pump CLI still assumes one buyer per transaction; generic grouping does not silently change that path or its retry/validation guards.

## Grouped Pump Jito launches

`slrd launch pump --submit-mode jito-bundle --buyers-per-transaction 3 ...` groups follower buys in their existing order. The creator buy remains in the deployment transaction. Each follower keeps its own input and protected minimum; all group wallets sign. There are at most four follower transactions, plus deployment. Grouping never creates multiple bundles automatically. Assembly enforces the selected wire version's packet/account limits. V0 remains limited to 1232 bytes; native V1 supports the existing 4096-byte/64-account guard.

A Jito dry run now performs the complete dependent `simulateBundle`, compute optimization and another simulation of the optimized generation. It requires `JITO_BUNDLE_SIMULATION_RPC_URL`. It does not send. Reprepare before switching the same plan from dry run to live. Grouped live receipts correspond to transactions; `buyerTransactions` maps each wallet to its transaction index and signature. Tip escalation preserves the actual final buyer as tip payer, even if another buyer pays that transaction's network fee.

For the locally prepared Fairfun launch:

```powershell
bun run scripts/launch-fairs.ts --simulate --slippage-bps 500
```

The wrapper reuses uploaded metadata and the exact encrypted pool reservation, selects a configured endpoint with working account reads, and builds four native-V1 transactions. A funded invocation additionally requires `--live --confirm-budget-sol <exact reviewed total>`; simulation is the default. Budgets come from `launches/fairs-2026-10-25/budget-proposal.json`, including separate reserves and fee/rent allowances. Nothing is submitted by the preparation scripts.
