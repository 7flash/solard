# Solard (`slrd`)

Wallets can be hidden from default lists and registry RPC scans with
`slrd wallet ignore <wallet>` and restored with `slrd wallet unignore <wallet>`.
Use `slrd wallets --ignore-zero` to ignore currently zero-SOL wallets in batched
reads, or `slrd wallets --ignored-only --addresses-only` to inspect the ignored
list without RPC calls. Keys and history are retained. See [ignored wallets](docs/wallet-ignore.md).

Replay persistence now declares attribution and coverage fields in its ORM schemas. A transactional pre-open migration preserves existing replay rows and retains original backup tables; unchanged starts do not rebuild them. Historical `_vN` tables are not deleted automatically.

The live allocation console at http://127.0.0.1:3817 supports range edits, new positions, source-timestamped market caps and finalized inventory reconciliation. Its `/rpc` page shows persisted Solard RPC timing and active work. See [Range Console](range-console/README.md) and [RPC observations](docs/rpc-observability.md).

Range allocation bid/ask mode targets 100% tokens at the lower cap, 50% at the midpoint and 100% SOL at the upper cap. A 10% step divides the range into ten intervals. The selected runner accepts `--allocation-config bid-ask-efge.json` to share its SDK wallet queue with the existing range strategies, while preserving separate inventory and journals. Explicit SOL-quoted legacy Raydium AMM v4 pools now support protected exact-input orders through the official SDK instruction builder; registration verifies pool, vaults, mint programs, decimals and reserves. See [bid-ask.md](bid-ask.md).

Solard is a capability-oriented Solana toolkit for multi-wallet operations, token trading, launches, historical market reconstruction, holder accounting, rewards, and liquidity management.

The CLI command is `slrd` (with `solard` as an alias). Applications should normally use `@solard/sdk`; the CLI and SDK share the same canonical `@solard/core` implementation and database.

Range trading now prepares Pump/PumpSwap orders in the background with fixed on-chain output floors, short-lived exact-byte preflight checks and no simulation at submission. `range-bots.ts` supports `--hold-ms 2000` to require two seconds of fresh qualifying observations (default zero), `--priority-micro-lamports 20000` and `--cu-limit 600000`. Sampling defaults to one second. Expired or changed preparation waits rather than rebuilding in the trigger. See [range-trade.md](range-trade.md). Funded worker receipts and operational status are tracked separately; preparation does not guarantee subsecond landing.

Range targets are pre-trade spot prices: minimum outputs account for modeled trade impact and protocol fees at the trigger boundary. Additional slippage defaults to 10% of the positive relative buy/sell spread, capped at 2% (`--range-slippage-share-bps 1000`); a 540k/580k range permits 0.74% extra. SDK callers can opt into this with `prepareFastTrade({ priceKind: "spot", additionalSlippageBps: 74, ... })`; existing average-price guards remain available. Custom quotes retain protected intermediate and final outputs.

## Packages

- `@solard/core` — canonical implementation: encrypted wallets, SQLite repositories, transaction construction/sending, token venues, history, claims, distributions, Pump/PumpSwap, Raydium, Meteora DLMM, groups, watches, and ALTs.
- `@solard/sdk` — curated public application API.
- `@solard/cli` — human CLI implementation.
- `solard-cli` — public `slrd` / `solard` wrapper package.

Solard is intentionally capability-oriented. Protocol access, deterministic parsing, transaction preparation, simulation, execution boundaries, and persistence belong in Solard. Strategy, scoring, scheduling, autonomous loops, prompts, and application policy belong outside the kernel.

## Custom-quote live-price and unsigned acceptance (candidate, not funded)

PumpSwap discovery probes bounded canonical pool PDAs first and, for noncanonical
creators, up to 12 recent mint signatures with at most 80 candidate accounts per
transaction, stopping when a verified route is found. Positive pool identities
are cached for five minutes; reserve reads remain fresh. Candidates require
verified on-chain pool ownership, discriminator, actual mint programs and
decimals, vault mint identities and positive reserves.
Missing historical RPC coverage can yield a missing route rather than a
fabricated price; provider pagination or independently verified explicit pool
metadata remains a supported fallback. A discovered route is not guaranteed
best execution or sufficient liquidity.

`createSolard().simulateUnsignedBuy({payer, mint, sol: "0.001", slippageBps: 500})`
uses a public payer identity, never reads a managed-wallet secret, and returns
an unsigned v0 plan with protected per-leg minima plus RPC simulation.
Oversized routes try independently verified active ALT accounts referenced by
recent pool activity. If no usable table exists, the caller may request
`proposeUnsignedBuyLookupTable(args)` for separate review-only creation and
extension messages. Nothing creates, registers, signs or broadcasts an ALT.
Rebuild the swap against activated tables and repeat simulation before any
funded transaction. No funded execution is established by unsigned simulation.

`prepareUnsignedTokenDeployment("pump", { payer, quoteAsset, name, symbol, uri,
creatorBuySol: sol("0.001") })` prepares creation, SOL-to-quote funding and the
protected creator buy atomically. `resolvePumpLaunchQuote(mint)` uses the pinned
Pump SDK 4.1.0 eligibility rules; the pending curve uses the protocol's Global,
QuoteControl or Pump-coin reserve calculation, rather than a spot-price estimate.
`simulateUnsignedTokenDeployment` and `simulateUnsignedSell` expose the same
public-payer review boundary. See [R6 acceptance](docs/custom-quote-r6-acceptance.md)
for prerequisites and read-only commands. Live launch and funded execution remain
unverified.

RPC endpoints can be managed with `slrd rpc add http <url>`, `slrd rpc add ws <url>`,
`slrd rpc test`, and `slrd rpc status`. These settings are stored separately from
wallets; diagnostics redact credentials and test mainnet/account-read readiness.
Failed native balance reads display `N/A`, not zero. See
[RPC management](docs/rpc-management.md) for configuration precedence, quota groups,
queue limits, and independent WebSocket settings. After a stream switch the SDK
fails closed with `feed-gap-unverified`; callers must reconcile and reopen the
subscription before receiving trading callbacks again.

## Requirements

- Bun `>= 1.1.0`
- A Solana RPC endpoint for chain operations
- A writable SQLite location
- A wallet password when signing-wallet secret material must be encrypted or decrypted

From the monorepo:

```bash
bun install
bun run cli --help
```

Direct CLI invocation:

```bash
bun run packages/cli/bin/solard.ts --help
```

## Environment

The most important settings are:

```text
SLRD_DB_PATH
    Shared CLI/SDK database.
    Default: ~/.solard/solard.sqlite
    SOLARD_DB_PATH is also accepted.

SLRD_MASTER_KEY
    Optional explicit wallet-encryption key for CI/automation.
    Interactive CLI signing commands can prompt instead.

RPC_ENDPOINT
    Solana RPC endpoint used for chain operations.

SOLARD_ENABLE_LIVE_TRADES=1
    Master opt-in for live-write paths that use Solard's live gate.
    Legacy SLRD_ENABLE_LIVE_TRADES and SOLWAL_ENABLE_LIVE_TRADES aliases are accepted.

SOLSCAN_API_KEY
    Optional indexed provider for historical transfer reconstruction.

HELIUS_RPC_URL
HELIUS_SENDER_URL
HELIUS_TIP_ACCOUNT
HELIUS_TIP_LAMPORTS
HELIUS_PRIORITY_MICRO_LAMPORTS
    Optional Helius RPC/sender configuration.

JITO_BLOCK_ENGINE_URL
    Optional Jito block-engine endpoint when Jito is explicitly selected.

SLRD_METADATA_UPLOADER
PUMP_IPFS_ENDPOINT
PINATA_JWT
IPFS_PUBLIC_GATEWAY
    Optional metadata-upload configuration.

GMGN_API_KEY
GMGN_API_URL
SOLARD_EXTERNAL_HTTP_TIMEOUT_MS
    Optional read-only GMGN research integration.
```

Solard JSON-RPC traffic is globally rate-limited to 5 requests/second by default. Relevant overrides include `SLRD_RPC_MAX_RPS`, `SLRD_RPC_NETWORK_RETRIES`, and `SLRD_JUPITER_MAX_RPS`.

SDK live subscriptions derive WebSocket access from `RPC_ENDPOINT` and check HTTP health and the WebSocket handshake before subscribing. A successful probe closes its temporary socket normally; this close is handled safely when Bun dispatches it synchronously on Windows. Genuine handshake failures include redacted endpoint diagnostics.

## Safety model

Solard does not use one execution flag for every historical command. Inspect `slrd help` or the command-specific help before using funded wallets.

For commands that use the live gate, the safe sequence is:

```text
1. Preview / inspect
2. Simulate when supported
3. Verify wallets, destination, amounts, exclusions, slippage, and venue
4. Set SOLARD_ENABLE_LIVE_TRADES=1
5. Re-run with --live
```

Some older trade commands use `--simulate-only`; newer plan-oriented operations generally use preview/simulation plus explicit `--live`.

## Wallets

Create a managed signing wallet:

```bash
slrd wallet create trader-1
```

Create a vanity wallet:

```bash
slrd wallet create trader-1 --vanity abc
```

Import a wallet:

```bash
slrd import <private_key> trader-2
```

Or from stdin:

```bash
cat key.json | slrd import --stdin trader-2
```

List wallets and SOL balances:

```bash
slrd wallets
```

Token scans are opt-in:

```bash
slrd wallets --tokens
slrd wallets --token <mint>
slrd wallets --only-with-tokens --tokens
```

Inspect one wallet:

```bash
slrd balances --wallet trader-1
```

Audit actual transaction fees and native/WSOL/SPL flow:

```bash
slrd fees --wallet trader-1 --since 30m
slrd sol-flow --wallet trader-1 --since 30m
```

The CLI and SDK use the same wallet database when they use the same `SLRD_DB_PATH`.

## Contacts

Contacts are public destination addresses only. They never contain signing material and are not wallet/group members.

```bash
slrd contact add treasury <SOLANA_ADDRESS>
slrd contact list
slrd contact show treasury
slrd contact remove treasury
```

Commands accepting `<contact|wallet|address>` resolve a contact, stored wallet name, or raw Solana address.

## Transfers

Native SOL:

```bash
slrd transfer treasury --wallet trader-1 --sol 0.1
```

SPL token:

```bash
slrd transfer treasury --wallet trader-1 --token <mint> --amount 25
```

Simulation-only:

```bash
slrd transfer treasury --wallet trader-1 --sol 0.1 --simulate-only
```

## Sweep / wallet consolidation

Preferred syntax:

```bash
slrd sweep --to treasury --below 1
```

This means: consider stored signing wallets, select wallets whose confirmed SOL balance is strictly below `1 SOL`, exclude the destination, calculate the transferable amount after required reserves/fees, and show a preview by default.

Simulation:

```bash
slrd sweep --to treasury --below 1 --simulate
```

Live:

```bash
SOLARD_ENABLE_LIVE_TRADES=1 slrd sweep --to treasury --below 1 --live
```

Compatibility syntax:

```bash
slrd sweep sol --to treasury --max-balance-sol 1
```

Useful controls include wallet inclusion, group/prefix exclusions, fixed reserves, and token-aware reserves. The threshold is exclusive: a wallet exactly equal to the threshold is not selected.

## Token registry

Register a token alias:

```bash
slrd token <mint> my-token
```

Update routing/metadata hints:

```bash
slrd token set <token|mint> --pool <address>
slrd token set <token|mint> --quote-mint <mint>
```

Refresh and list:

```bash
slrd token refresh <token|mint>
slrd tokens
```

## Holder snapshots

A holder snapshot is the authoritative point-in-time ownership view:

```bash
slrd holders <token|mint>
```

SDK:

```ts
const snapshot = await slrd.snapshotHolders(mint, {
  commitment: "finalized",
});

console.log(snapshot.holderCount, snapshot.supplyRaw);
```

Do not reconstruct current balances solely from a live event stream. Use a holder snapshot when authoritative current ownership matters.

## Historical data: three different concepts

Solard deliberately separates holder-state replay, verified market trades, and market candles. Do not treat them as interchangeable.

### 1. Holder-balance replay

`history.replay()` reconstructs historical balance/claim state. Its current replay transaction kinds are:

```text
mint
burn
transfer
change_owner
claim
```

Replay items contain historical balance changes and claim payouts. Ordering metadata such as timestamp/transaction/instruction indexes can be nullable when the chain/provider cannot certify them.

A transfer is only a token movement. **Never infer that a transfer is a purchase merely because one wallet gained tokens.**

### 2. Verified exact market trades

`slrd token backfill <mint>` builds the durable exact-trade history and sparse one-second candle materialization.

```bash
slrd token backfill <mint>
slrd token trades <mint>
slrd token trades <mint> --owner <wallet> --side buy
slrd token analyze <mint>
```

For Pump/PumpSwap history, Solard does not classify trades from balance movements alone. The parser verifies the actual on-chain program and supported instruction discriminator.

For a PumpSwap trade to be classified as `pumpswap`, the transaction must contain an instruction executed by the canonical Pump AMM program and match a recognized PumpSwap buy/sell instruction such as the supported exact-quote buy, legacy buy, or sell discriminator. Solard then derives the trader, target-token delta, quote economics, and effective price from that real transaction.

This distinction is security-critical. A user cannot earn trade credit simply by transferring tokens to themselves and moving SOL in the same transaction.

For fee/reward systems, only **verified venue trades** should be considered economic activity. Generic transfers, airdrops, mints, burns, manual SOL transfers, and fabricated matching balance movements must not count as swaps.

### 3. Market candles

The public SDK `history.market()` returns durable market history summarized as sparse one-second candles:

```ts
const market = await slrd.history.market(mint, {
  backfill: true,
});

for (const candle of market.candles1s) {
  console.log(candle);
}
```

The public result is conceptually:

```ts
type MarketHistory = {
  mint: string;
  quoteMint: string;
  coverage: TokenHistoryCoverage;
  candles1s: readonly TokenHistoryCandle1s[];
};
```

Use candles for price/time-series analysis. Use verified exact trades for per-wallet purchase/sale attribution. Use replay for historical holder/claim state.

## Fee/reward attribution invariant

Applications such as FairFun that reward holders based on trading activity must use a strict rule:

> Credit activity only when Solard has verified a real swap through the intended on-chain venue/program. Never infer fee contribution from token/SOL deltas or generic transfer replay.

For PumpSwap, the authoritative trade record should provide, at minimum:

```ts
type VerifiedPumpSwapTrade = {
  signature: string;
  slot: number;
  venue: "pumpswap";
  side: "buy" | "sell";
  trader: string;
  mint: string;
  tokenAmountRaw: bigint;
  quoteMint: string;
  quoteAmountRaw: bigint;
};
```

If an application rewards **quote volume**, it can sum verified buy `quoteAmountRaw` per holder.

If an application rewards **actual fee contribution**, quote volume is not the fee. The canonical event should expose the fee components that can be deterministically proven from the PumpSwap transaction, for example creator/protocol fee amounts. Until those exact fee fields are exposed, do not label total quote spent as an exact fee total.

### Replay integration direction

A future/extended replay contract may enrich a holder mutation with a verified `buy`/`sell` classification when it is backed by the same canonical PumpSwap transaction. Such enrichment must reuse the verified PumpSwap parser; it must never classify swaps from balance direction alone.

It also must not double-apply the token balance change: a swap classification describes the economics of the same underlying holder mutation rather than creating a second independent balance mutation.

Until that verified-swap enrichment is part of the public replay contract, applications needing per-holder purchase economics should use the durable exact-trade history rather than inventing `buy`/`sell` fields on `ReplayItem`.

## Live token events

```bash
slrd events <token|mint>
slrd events <token|mint> --swaps
slrd events <token|mint> --transfers
slrd events <token|mint> --all --jsonl
```

The live token-event subsystem can emit typed Pump/PumpSwap swap events as well as transfer/create events. PumpSwap swap events are produced by the real venue parser and include fields such as venue, side, trader, token amount, quote mint, quote amount, and price when derivable.

Historical holder movements are available separately:

```bash
slrd events history <token|mint>
```

## Prices

Current quote:

```bash
slrd quote buy <token|mint> --sol 0.1
```

Current venue price:

```bash
slrd price <token|mint>
```

Stored average/watch:

```bash
slrd price average <token|mint> --period 15m
slrd price watch <token|mint> --interval 1s --period 1m
```

SDK:

```ts
const price = await slrd.samplePrice(mint);
```

## Backtesting

```bash
slrd backtest <mint> \
  --dip-pct 20 \
  --profit-pct 40 \
  --buy-sol 0.1
```

By default the backtester uses sparse one-second market candles. Use `--exact-trades` when the strategy requires the durable exact-fill tape.

Additional controls include time range, capital, slippage, venue fee, network fee, latency, start-coverage requirements, ledger output, and JSON output.

## Trading

Jupiter exact-input swap:

```bash
slrd swap --from SOL --to <mint> --amount 0.1 --wallet trader-1
```

Live:

```bash
SOLARD_ENABLE_LIVE_TRADES=1 slrd swap \
  --from SOL \
  --to <mint> \
  --amount 0.1 \
  --wallet trader-1 \
  --live
```

Buy/sell:

```bash
slrd buy <token|mint> --wallet trader-1 --sol 0.05
slrd sell <token|mint> --wallet trader-1
```

Multi-wallet/group targeting is supported where documented:

```bash
slrd buy <token|mint> --wallets a,b,c --sol 0.05
slrd buy <token|mint> --group buyers --sol 0.05
slrd sell <token|mint> --group buyers --bps 5000
```

Routing can use native Solard venues or Jupiter where supported. Sender selection can include RPC, Helius, or Jito on commands that expose sender choice.

## Token liquidation

Preview/simulate carefully:

```bash
slrd liquidate tokens --except <protected-token>
slrd liquidate tokens --except-wallet treasury --simulate
```

Live:

```bash
SOLARD_ENABLE_LIVE_TRADES=1 slrd liquidate tokens --except <protected-token> --live
```

Excluded wallets are not scanned or touched.

## Batch transfers

```bash
slrd transfer-many \
  --wallet trader-1 \
  --sol \
  --file allocations.json \
  --id payout-2026-01 \
  --live
```

Resume/status:

```bash
slrd transfer-many status payout-2026-01
slrd transfer-many resume payout-2026-01
```

Use stable IDs for resumable workflows.

## Pump launches and metadata

Metadata upload:

```bash
slrd metadata upload \
  --image ./token.png \
  --name "Example" \
  --symbol EX \
  --description "Example token"
```

Launch:

```bash
slrd launch pump \
  --creator trader-1 \
  --image ./token.png \
  --description "Example token"
```

Solard also supports external-payer preparation, deploy/vamp flows, vanity mint pools, quote-mint selection, beneficiary routing, and launch-specific sender policy.

## Raydium

Quote:

```bash
slrd raydium quote --from SOL --to <mint> --amount 1
```

LaunchLab configuration discovery:

```bash
slrd raydium launchlab configs
slrd raydium launchlab configs --quote <QUOTE_MINT>
```

LaunchLab launch/buy/sell and arbitrary SPL/SPL CPMM creation are also supported. LaunchLab quote mints require an on-chain LaunchLab configuration; use CPMM creation for arbitrary pairs when no LaunchLab quote configuration exists.

## Meteora DLMM

Discovery/data:

```bash
slrd meteora discover --timeframe 30m --sort fee-active-tvl --limit 20
slrd meteora opportunities --timeframe 30m --sort flow-inactive --limit 20
slrd meteora token-pools <mint|symbol> --timeframe 30m
slrd meteora pools --timeframe 30m --sort fee-tvl --limit 20
slrd meteora pool <pool>
slrd meteora candles <pool> --timeframe 5m
```

Positions:

```bash
slrd meteora positions --wallet trader-1
```

Lifecycle:

```bash
slrd meteora open <pool> --wallet trader-1 --sol 0.1 --bins 40 --strategy spot
slrd meteora move <position> --wallet trader-1 --bins 10
slrd meteora migrate <position> --wallet trader-1 --to-pool <pool> --bins 10
slrd meteora add <position> --wallet trader-1
slrd meteora remove <position> --wallet trader-1
slrd meteora claim <position> --wallet trader-1
slrd meteora close <position> --wallet trader-1
```

Pool quote/swap:

```bash
slrd meteora quote <pool> --in-x <amount>
slrd meteora swap <pool> --wallet trader-1 --in-x <amount>
```

Meteora mutations are prepare/simulation-oriented unless execution is explicitly enabled. Live writes retain Solard's live gate.

`discover` and indexed `pools` expose different TVL/fee-ratio semantics; do not treat `active_tvl` / `fee_active_tvl_ratio` as interchangeable with indexed `tvl` / `fee_tvl_ratio`.

## Rewards and cumulative distributions

History/inspection:

```bash
slrd rewards history <token|mint>
slrd rewards inspect <token|mint>
```

Distribution:

```bash
slrd rewards distribute \
  <token|mint> \
  --wallet <beneficiary> \
  --snapshot snapshot.json
```

Lifecycle:

```bash
slrd rewards status <token|mint>
slrd rewards audit <token|mint>
slrd rewards stop <token|mint>
```

Creator-reward claims:

```bash
slrd rewards claim <token|mint> --wallet <fee-payer>
slrd rewards claim-status <stable-claim-id>
```

The public SDK exposes the same core concepts through `claims.creatorFees` and `distributions`.

## Groups

```bash
slrd group create buyers
slrd group add buyers trader-1
slrd group add-many buyers trader-1,trader-2,trader-3
slrd group show buyers
slrd group list
```

## Scripts and strategies

Strategies stay outside the kernel:

```bash
slrd scripts
slrd run <name-or-path> [script flags...]
```

A script should compose Solard capabilities rather than duplicating wallet, chain, venue, or history logic.

## Public SDK

Prefer `@solard/sdk` in applications:

```ts
import { createTraderSolard } from "@solard/sdk";

const slrd = createTraderSolard({
  dbPath: "./data/solard.sqlite",
});

try {
  const wallet = slrd.createWallet("trader-1");
  const wallets = slrd.listWallets();
  const token = slrd.resolveToken("<MINT>");

  const price = await slrd.samplePrice(token.mint);
  const holders = await slrd.snapshotHolders(token.mint, {
    commitment: "finalized",
  });
  const replay = await slrd.history.replay(token.mint);
  const market = await slrd.history.market(token.mint, {
    backfill: true,
  });

  console.log({
    wallet: wallet.address,
    walletCount: wallets.length,
    price: price.priceQuotePerToken,
    holderCount: holders.holderCount,
    replayEvents: replay.items.length,
    marketCandles: market.candles1s.length,
  });
} finally {
  slrd.close();
}
```

The curated SDK surface includes `createSolard`, `createTraderSolard`, amount helpers, history/replay/market APIs, live events, creator claims, cumulative distributions, wallet methods, token resolution, holder snapshots, balances, current price sampling, and buy/sell capabilities.

Do not make application integrations depend on secret-bearing core repositories or internal database handles when the public SDK already exposes the required capability.

## Diagnostics

Commands collect `measure-fn` telemetry without streaming every span by default.

Aggregate timings:

```bash
slrd <command> ... --measure
```

Raw low-level streaming:

```bash
slrd <command> ... --measure-stream
```

Use `--debug` only when a full stack/error trace is needed.

## Development

```bash
bun install
bun run cli --help
bun run typecheck
bun run test
```

The workspace packages are versioned together. Internal Solard package versions should remain synchronized.

## Design rules

1. Keep protocol, chain, parsing, persistence, and deterministic execution capabilities in Solard.
2. Keep presentation in the CLI and application-specific strategy outside the kernel.
3. Prefer the public `@solard/sdk` membrane for integrations.
4. Do not infer swaps from transfers or balance direction alone.
5. For PumpSwap attribution, require the canonical Pump AMM program and a recognized real swap instruction.
6. Keep holder-state replay, exact verified trades, and market candles conceptually distinct unless a public API intentionally joins them without losing provenance.
7. Never double-count one on-chain mutation when enriching a transfer with swap semantics.
8. Preserve preview/simulation boundaries for destructive operations.
9. Require explicit live intent on live-gated operations.
10. Never expose wallet secrets or secret-bearing repositories through the public SDK.

## License

MIT.
# Mements capabilities

The public SDK now exposes creator-fee discovery and batch claims, LaunchLab preparation/execution, migration notifications, value-band strategies, cached historical tapes/backtests, wallet ledger and token-account maintenance. See [the API handoff and coverage limits](docs/mements-capabilities.md) before integrating. These additions target the unpublished 0.2.30 source release; funded acceptance remains pending.

Custom Pump quote trades use atomic venue legs. Quote funding and exit chains are limited to four venues including the target; repeated mints reject with `CONVERSION_UNAVAILABLE`. Each next leg spends only the preceding guaranteed minimum, preserving unrelated quote holdings. Plan `fundingRoute.legs` / `exitRoute.legs` record per-leg raw inputs, minima and slippage; the target action retains total SOL input or guaranteed final SOL output. This uses individual venue instructions, with each venue charging its own fees; it does not implement PumpSwap `multi_hop_swap`. Custom-quote curve trades create the buyback quote ATA idempotently with the verified quote token program.

Read-only SEEDCAT mainnet verification is reproducible with `bun run scripts/verify-seedcat-plans.ts`. The captured custom-quote buy/sell instruction fixture validates quote eligibility, Token-2022 programs, and meaningful per-leg minima. Without lookup tables the observed plans measured 1,657/1,547 wire bytes; assembly rejects with `TransactionTooLargeError` and lookup candidates before accessing a signing key. This construction check does not establish funded simulation or live execution acceptance.

### Consumer TypeScript declarations

`bun run build:types` generates the core and curated SDK declaration graphs.
Package exports select `dist/types` for TypeScript and retain Bun runtime entry points.
`npm pack` regenerates these files via prepack; publish matching core/SDK archives.
`bun run test:types` installs actual archives into an isolated strict TypeScript 5.9
consumer, checks public contracts and expected type errors, then imports the SDK at runtime.
The consumer uses `skipLibCheck: true` to exclude upstream protocol declaration defects.
Solard implementation source and sqlite-zod-orm's older measure-fn source are not traversed.
No global measure-fn override or consumer patch is required. Full implementation typechecks
remain a separate release gate; declaration emission alone does not certify execution.

### Absolute output floors in CLI trades

For native Pump curves and PumpSwap (including atomic custom-quote routes),
choose an absolute final output instead of a percentage:

```sh
slrd buy <mint> --wallet main --sol 0.01 --min-out 12000 --simulate-only
slrd sell <mint> --wallet main --bps 10000 --min-out 0.009 --simulate-only
slrd buy <mint> --wallet main --sol 0.01 --min-out-raw 12000000000 --simulate-only
```

Buy `--min-out` is the number of target tokens in human units; sell `--min-out`
is SOL. `--min-out-raw` uses target-token raw units for buys and lamports for sells.
The floor applies separately to each wallet, is encoded in the final on-chain swap,
and appears as the plan's guaranteed output. An above-quote floor fails before signing.
Do not combine these flags with `--slippage-bps`. Custom-quote intermediate legs retain
bounded slippage protection and consume only guaranteed intermediate output.
Jupiter currently rejects these flags because its order path does not expose a verified
on-chain floor. The existing slippage defaults are unchanged when no minimum is passed.

CLI auto-routing inspects uncached mints and refreshes non-native/unknown cached metadata
before choosing Jupiter. A missing cache entry does not establish that Pump routing is unavailable.
Provider discovery failures surface directly; explicit `--venue jupiter` bypasses native discovery.

For a buy price ceiling, specify SOL per whole token instead of calculating token output:

```sh
slrd buy <mint> --wallet main --sol 0.1 --max-price-sol 0.000001 --simulate-only
```

This derives a rounded-up raw token minimum from the SOL budget and verified token decimals,
then enforces it in the final on-chain swap. It caps worst-case SOL principal per received
whole token, including venue fees/price impact through output; network fees, tips and account
rent are separate. It is supported on the same native routes as `--min-out` and cannot be
combined with `--slippage-bps`. If also given a token minimum, the stricter floor applies.
An above-limit quote fails before signing; it does not wait for the price to recover.

SDK price-only buys (`maxPriceSol` with no explicit `slippageBps`) now derive the same
on-chain output floor as CLI price ceilings. Passing an explicit slippage percentage retains
both checks. An intent key identifies one saved trade request: reconciliation reads its result,
not a fresh attempt. The SMA example logs status, code, phase, message and submitted-attempt
count so a failed quote can be distinguished from missing wallet/password configuration.

The local SMA example `trade.ts` accepts `--rpc-url <http-url>` to override its process RPC
without changing the wallet database/config. It registers an unknown mint once before sampling
and exits on registration failure instead of repeating UNKNOWN_TOKEN every tick.

SMA sampling converts custom quote prices through verified quote/SOL reserves, preserving
the original quote identity. Missing conversion blocks the tick; no custom quote is labeled SOL.

PumpSwap discovery splits candidate account reads into batches of at most10 for public
providers with small per-request account caps. Such a batch-cap rejection is distinct from
request-rate429 or account-quota exhaustion.

Explicit PumpSwap pool registration validates the supplied pool and vault/mint identities
without unrelated venue discovery. SMA quote conversion uses registered pool hints, rereading
the actual pool and reserves, so public providers need not support indexed history lookups.

SMA ticks include RPC work in the configured interval rather than adding an extra full
interval after each request; the existing sample coverage and maximum-gap guards remain.

SDK price-only sells (`minPriceSol` without explicit `slippageBps`) encode the stricter of
the price-derived SOL floor and minOutputLamports. Intermediate sell legs protect their
full quoted output; the final leg encodes the user floor. Explicit percentage slippage
retains its previous guard behavior. No SMA or profit target is lowered.

### Live SMA target CSV

`bun run report-trade-targets.ts --once` writes `bot-targets.csv`, replacing the latest
snapshot rather than appending history. Run it under bgrun without restarting trading bots:

```sh
bunx bgrun --name sma-targets-csv --command "bun run report-trade-targets.ts" --directory C:/Code/solwal --no-config
```

There is one row per token/wallet state file (default wallet ddm6), refreshed about every
5 seconds. Columns include current price/cap, SMA buy/sell prices and USD caps, and the
**effective sell target** after the position profit floor. This is a read-only reporter:
it does not submit trades, access wallet secrets or alter strategy thresholds.
Supply/decimals are verified on-chain every5 minutes, SOL/USD refreshes every minute,
and unavailable/stale conversion metadata leaves USD cap fields blank. Warmup/stale
prices leave actionable targets blank. USD caps use total verified mint supply; they
are derived targets, not an executable quote or circulating-supply estimate.

Reporter `--sma`, `--range`, `--profit`, `--interval` settings must match the bots it reads
(default5m/2%/1%/5000ms). `--wallet`, `--output`, and `--rpc-url` select the reporting scope
and destination. The reporter atomically replaces the CSV; use one reporter per output.

### Registry token liquidation

`slrd liquidate tokens --live` processes wallets sequentially. Completed wallets do not depend on a later wallet scan succeeding. Temporary read failures back off before retrying; execution itself is never replayed by the wallet runner. Use `--rpc-delay-ms` (default 2500) to pace token-account scans on public RPC. SOL stays in each wallet; unsupported holdings are reported and not burned without `--burn-unsellable`. A wallet failure is reported, later wallets still run, and the command exits unsuccessfully if work remains.

Live registry liquidation completes its selling pass across selected wallets before closing empty token accounts in a separate cleanup pass. A wallet with an execution error is excluded from automatic cleanup replay.

Custom-quote conversion checks verified native Pump routes first, then uses configured Jupiter routing without scanning unrelated protocols. Atomic buys retain the final absolute token minimum while allowing bounded intermediate funding slippage; only guaranteed funding output is spent.
Quote-to-SOL fallback conversion sizes probes to a small SOL notional rather than selling a fixed 100 quote tokens, preventing BTC-sized price-impact distortion.
Immediate fee recompilation reuses the same validated lookup tables and blockhash for up to 15 seconds, avoiding redundant RPC reads; recompiled transactions still enforce packet limits, price guards and simulation.
Range manager enables detailed measure-fn transport spans: RPC provider queue versus network attempts, and Jupiter rate-limit queue versus HTTP attempts. Logs contain method/status labels rather than endpoint credentials or request payloads.
Reported manual exits with verified finalized zero balances are recorded as external exits with unknown proceeds/profit, allowing a fresh bot cycle without inventing trade accounting.
The range manager opts into SLRD_RPC_TRADE_PRIORITY=1: build/fee/preflight requests get admission preference during execution while background reads retain one admission opportunity per 1.1 seconds. Existing shared/provider quotas stay unchanged; confirmation waits do not hold trade priority. This preference is local to the process.
Absolute output floors on supported Jupiter exact-input routes are checked and encoded in the returned instruction itself. Unknown layouts fail before signing. Jupiter quotes request at most 32 route accounts to reduce composed v0 transaction size; final size checks still apply. Select transactionVersion: 1 on the SDK client for native 4096-byte v1 plans; legacy clients default to v0.

V1 transactions: createTraderSolard({ rpcUrl, transactionVersion: 1 }) builds, signs, simulates and submits native v1 bytes with a 4096-byte limit and no lookup tables. The range manager enables this option. Existing clients retain v0 by default; SOLARD_TRANSACTION_VERSION=1 also opts assembly in. Compute limits and the total priority fee are stored in the v1 config, with an explicit 64 MiB loaded-account cap. ComputeBudget instructions inside a v1 draft are rejected. Signed journal recovery detects the original version and rebroadcasts identical bytes without rebuilding. Public unsigned plans keep every signature zero; external v1 signing is asynchronous and must be awaited. Read-only mainnet verification: SOLARD_V1_READ_ONLY=1 and SOLARD_PUBLIC_WALLET=<public-address>, bun run scripts/verify-v1-read-only.ts. This simulates a >1232-byte memo and does not broadcast.
Hide archived empty wallets with: slrd wallets --except oct23-empty. Comma-separated exclusions and the virtual ungrouped group are supported; unknown group names fail explicitly. Exclusion runs before balance RPC reads. Groups preserve the existing wallet keys and history in one database.
Liquidation planning reuses registered pool/Jupiter metadata and still resolves the live venue before execution, avoiding unrelated native protocol scans for known quote assets. Fresh portfolio mint decimals and token programs override stale registry values.

FAIRS launch preparation: see launches/fairs-2026-10-23/README.md for the finalized wallet inventory and non-executable draft config. Regeneration overwrites drafts; buy budgets and deployment metadata remain unset.


Range history export marks tokens needing accounting review in the aggregate CSV and preserves their existing detailed history. One incomplete older token does not block other tokens from exporting.


Confirmed trade recovery retries missing fill metadata using the compatible v1 parsed transport. It preserves the original signature and confirmation; metadata retries never create another trade. Range bots wait for verified fill fields before creating a position.


Automatic trade fee discovery waits at most 250ms for optional recent-priority samples. Account-scoped samples cache for 10s (stale fallback up to 60s), repeated failures cool down for 5s, and in-flight lookups coalesce. Missing suggestions use the existing configured floor/caps. Explicit fixed bids skip discovery. Optional fee HTTP429/network failures are not retried by the transport. This bounds fee discovery, not the entire trade or RPC settlement.


Price-only custom-quote buys use zero percentage slippage on intermediate funding when the caller omitted slippageBps, retaining the final absolute token minimum. The downstream leg spends only guaranteed funding output; no unrelated holdings are consumed. This removes the implicit default funding haircut but can reject adverse movement on the funding market. Explicit slippage retains existing behavior. Range quote-conversion and supply reads use Solard's shared RPC limiter.


Range supply and SOL/USD metadata refresh outside the decision loop after45s. Decisions use only timestamp-valid verified values under the existing120s limit; missing/expired data pauses new decisions. Refreshes coalesce and failed reads cool down without changing data timestamps. A hung refresh no longer blocks a sell while its prior metadata remains valid. Price RPC and transaction build delays are still separately observable.


A market-cap CSV sell floor at or below its buy ceiling now means exits enabled, new entries paused. This lets an existing position honor a lowered exit target without creating repeated buy/sell trades across overlapping thresholds. Restore sell greater than buy to resume entries. Nonpositive/malformed values still reject, and hard on-chain minimum outputs remain enforced.


Verified manual exits can persist an entryPause reason on the bot state. This blocks buying back after restart even if the CSV buy ceiling is crossed; existing exits remain possible. Resume requires an explicit user action, not merely a fresh price or config edit. A manual exit is recorded separately from a bot fill.


Token-balance reads return zero only for a genuinely missing associated token account. RPC, quota and account-owner failures propagate instead of masquerading as empty holdings. Uncached mint program/decimals/supply are decoded from a single account response, removing the previous second read.


Range observations retain a conservative source/request timestamp instead of appearing freshly captured after a slow RPC. Direct buy/sell stage hooks now include wallet-queue time separately from building and settlement. See .docs/analysis/range-reliability-2026-10-24.md for the stopped-trading remediation and acceptance plan.

Bid/ask ladder strategy: see [bid-ask.md](bid-ask.md) for half-budget initialization, percentage bins, isolated inventory, paper mode and explicit boundary behavior. This is a separate script from the SMA and range strategies.
The operational selected range runner supports repeatable `--also-mint <mint>` to run up to eight explicitly chosen range bots with one SDK wallet queue and shared CSV/SOL-USD sources. Other CSV rows remain inactive. Every selected allocation and market preparation is validated before startup.

Selected native-SOL Pump/PumpSwap bots share one validated reserve-account price batch per second. Mint decimals/programs, curve/pool identities and vault identities are verified against the response; existing freshness guards remain. Custom quotes and other venues retain the normal verified sampling/conversion path.
Explicitly adopted existing positions keep a separate confirmed-acquisition artifact under `.range-bots/bot-adoptions/`. Their original buy signatures and observed acquisition costs are included in range history without fabricating a bot execution or sending another buy.

SDK transaction composition is available through `tx()`, `composeTransactionDrafts()` and `compileGroups()`. Preserve ordered operations, action minima, tracked accounts and all co-signers; grouped compilation pins one blockhash generation without submitting. See [transaction composition](docs/transaction-composition.md).

Release preflight now runs before `pub` bumps versions, and again before publishing the new version. App-only allocation code stays outside published core; root tests include its lifecycle test. Use `bun run pub:verify` to validate archives without publishing.

Grouped Pump Jito launches support `--buyers-per-transaction 1..3`. Dry runs simulate the complete dependent bundle and optimized compute limits. See [transaction composition](docs/transaction-composition.md). The local FAIRS preparation can be checked with `bun run scripts/launch-fairs.ts --simulate --slippage-bps 500`; funded execution requires an explicit matching budget confirmation.

For automatic RPC failover, pass `rpcUrls` containing every allowed endpoint. A lone `rpcUrl` provides no backups. FAIRS operation scripts now share both configured Helius endpoints plus public mainnet through `scripts/fairs-rpc.ts`. Quota errors on reads rotate to a working endpoint and remain there. Ambiguous signed submissions retain their original signature and are reconciled rather than blindly sent as replacement transactions.

Built-in HTTP pacing can be shared by trading, holder/fee reads, raw history batches, listener enrichment and live readiness probes:

```ts
import {createSolard, createRpcPacer} from '@solard/sdk';
const rpc = createRpcPacer({
  maxRps: 4,
  maxConcurrent: 8,
  retryOn429: {attempts: 4, honorRetryAfter: true},
});
const sdk = createSolard({rpcUrls: ['https://your-rpc.example'], rpc});
// Other clients can receive the same rpc instance to share this budget.
```

Alternatively pass the options directly as `rpc: {maxRps: 4, maxConcurrent: 8}`. Supply `fetch` to the factory or `createRpcPacer(options, fetch)` to inject a transport without patching globals. Each endpoint has a sliding one-second window, a bounded waiting queue, concurrency cap and shared 429 pause. Retry-After pauses all queued requests to that endpoint. Signed sends, mixed batches containing sends, opaque bodies and one-shot Request bodies are never automatically replayed by the pacer. Existing core provider limits can impose a lower throughput/concurrency cap; this option does not increase provider quota.

Pacer instances share HTTP budgets within one process. Existing `SLRD_RPC_GATE_DB` reservations remain the opt-in cross-process limit; concurrency remains process-local. HTTP pacing does not count WebSocket messages or implement reconnect backoff. The separate browser SDK client is unchanged. Without explicit pacing options, core retains its existing environment-configured rate gate; Node SDK live HTTP now uses that controlled transport too.

Rate slots remain reserved until the transport is invoked. Sliding-window and pause deadlines use a monotonic clock, so synchronous observer delays cannot cause early dispatch or expire an unstarted request's slot. Regression tests enforce the rate against physical transport invocation times.

The local 100-mint generation job is `pump-mint-batch-100` under bgrun. It runs `scripts/pregenerate-pump-mints.ts`, stores each `pump` mint encrypted in the configured Solard database, removes its temporary key file after persistence, and checkpoints public addresses in `.docs/vanity-pump-20261026/receipt.json`. Restarting resumes that batch; it does not deploy or fund anything. This local pool is separate from FairFun's server mint creation.

Luffy/STRAWHAT preparation and the tested three-transaction launch plus one-transaction eight-wallet exit layout are documented in [the STRAWHAT review](launches/strawhat-2026-10-26/README.md). `bun run scripts/launch-strawhat.ts` defaults to unsigned preparation/simulation; it does not deploy. Explicit live budget/floor flags are required for any funded operation.

`bun run scripts/analyze-fairs-exits.ts` audits finalized FAIRS bundle buys and exits without signing. The report and public transaction evidence are saved under `launches/fairs-2026-10-25/exit-pnl-*.json`; net P&L includes wallet fee and rent changes, with the creator's launch debit shown separately.

BIBI launch preparation and reviewed metadata/budgets are documented in [launches/bibi-2026-10-26/README.md](launches/bibi-2026-10-26/README.md). Prepared launch bundles use Jito; their single atomic exits use RPC and exclude the deployer.

Launch buyer exclusions are stored in launches/excluded-buyer-wallets.json. Preparation and new live launch validation reject excluded buyers until a replacement allocation is reviewed. Existing journal resume/exit remains available to close previously purchased holdings.


Launch preparation accepts SOLARD_LAUNCH_BUYERS_FILE for an explicit reviewed buyer list and SOLARD_LAUNCH_CREATOR_FEE_RECIPIENT for the onchain creator. Exclusions remain enforced. scripts/launch-bow.ts prepares the six-wallet 3 SOL Bow campaign without broadcasting by default.


New campaign launch transactions permit one buyer each; creation occupies its own transaction and Jito launch bundles are capped at five. Grouped exits remain supported. Bow's earlier grouped-buyer review is superseded pending a reduced buyer selection.


Pump launchpad supports holderReward:true using the official SDK and protocol reward PDA for trade routing; it requires the global holder-reward gate. Holder rewards replace wallet creator-fee sharing and distribution requires Pump's configured claim authority. scripts/prepare-bow-holder-rewards.ts prepares only, with no automatic sale or broadcast.


Prepared launch runners support a persisted hold-after-buys policy: wait for launch confirmation, mark the journal held and never sign or submit a sell. Resume cannot change that policy. The holder-reward Bow campaign uses this policy.


Launch exits can require a ceiling-rounded minimum of 110 percent of each buyer's SOL trade budget. Sequential mode submits one wallet's sell through RPC and confirms it before the next, preserving that minimum and all confirmed signatures across expiry replacements. Existing IPFS metadata may be reused with original downloaded image bytes and hashes retained for review.


Campaigns can specify SOLARD_LAUNCH_BUY_AMOUNTS_FILE mapping each selected wallet to its exact SOL trade budget. The selection must match exactly, each amount must be positive, the sum must equal the approved total, and balances must retain the existing reserves.


Explicit eight-buyer campaigns use two confirmed Jito batches (5 and 4 transactions), each with its own tip. They are not atomic together. After both confirm, the runner derives actual purchased units from the known signed buy transactions before signing sequential exits; current balances must match. A later batch failure records partial execution and never replays creation.

# Launch atomicity

Live listeners support SQD (default) or `source: "rpc"` through the same API.
See [event sources](docs/event-sources.md) for configuration, finality, live token
events, remaining RPC reads and bounded read-only verification.

Campaigns can select a dedicated managed deployer with
`SOLARD_LAUNCH_DEPLOYER`; the preparation report and signer follow that address.
`scripts/prepare-fresh-deployer.ts` creates one persisted wallet per campaign
and optionally funds its rent/fee reserve through a durable transfer intent.

Confirmed campaign exits sell only their recorded token allocation. Additional
tokens in the same wallet are preserved, including their token account; a
balance below the recorded allocation still stops the exit for reconciliation.

Campaigns may opt into confirmed-fill reconciliation for one combined exit,
including three individual buys followed by one RPC sale of all three positions.
An immediate zero-floor sale requires explicit campaign authorization and does
not guarantee profit or a particular execution latency.

New prepared campaign launches must fit one Jito bundle (at most five
transactions). Eight buyers can be packed two per transaction after creation.
Buyer-to-transaction mappings and confirmed wallet fills are persisted before
exit signing; plans that do not fit fail rather than splitting automatically.
# Scout terminal and two-sided trading

[Wallet-presence ranking](docs/wallet-presence-ranking.md) tests frozen wallet
labels on later launches and produces a current, coverage-labelled coin report.

Read-only launch-family research is available through
[launch-cohort-analysis.md](docs/launch-cohort-analysis.md), including IRONYMAN
and ALON grouping, observation coverage, early-flow comparisons and source hashes.

See [scout-terminal.md](docs/scout-terminal.md) for terminal range controls and
[bid-ask.md](bid-ask.md) for the existing two-sided inventory strategy. The scout
manager can host both with one shared wallet queue and distinct mint ownership.

