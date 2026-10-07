# Solard (`slrd`)

Solard is a capability-oriented Solana toolkit for multi-wallet operations, token trading, launches, historical market reconstruction, holder accounting, rewards, and liquidity management.

The CLI command is `slrd` (with `solard` as an alias). Applications should normally use `@solard/sdk`; the CLI and SDK share the same canonical `@solard/core` implementation and database.

## Packages

- `@solard/core` — canonical implementation: encrypted wallets, SQLite repositories, transaction construction/sending, token venues, history, claims, distributions, Pump/PumpSwap, Raydium, Meteora DLMM, groups, watches, and ALTs.
- `@solard/sdk` — curated public application API.
- `@solard/cli` — human CLI implementation.
- `solard-cli` — public `slrd` / `solard` wrapper package.

Solard is intentionally capability-oriented. Protocol access, deterministic parsing, transaction preparation, simulation, execution boundaries, and persistence belong in Solard. Strategy, scoring, scheduling, autonomous loops, prompts, and application policy belong outside the kernel.

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
