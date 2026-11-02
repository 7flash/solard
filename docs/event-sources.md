# SQD and RPC event sources

Live trades, launches, migrations and typed token events use the same decoding
and market validation with either transport. SQD is now the default in core and
the Node SDK. Select RPC explicitly for the existing WebSocket endpoint pool.

```ts
const sdk = createSolard({
  rpcUrl,                      // account metadata, conversion and enrichment
  source: "sqd",               // default
  sqd: { portalUrl: "https://portal.sqd.dev/datasets/solana-mainnet" },
});

const listener = await sdk.listenTrades({ tokens: [mint] });
listener.onTrade(event => console.log(event.market, event.eventSource));
listener.onMigration(event => console.log(event.newPool));
await listener.add(otherMint);
await listener.remove(otherMint);
await listener.close();

// Identical listener API, using the RPC WebSocket backend instead.
const rpcListener = await sdk.listenTrades({ tokens: [mint], source: "rpc" });
await rpcListener.close();

// Typed swap/create/transfer events retain their existing event union.
const events = await sdk.events.subscribeToken(mint, {
  source: "sqd", commitment: "finalized",
});
for await (const event of events) console.log(event);
await events.close();
sdk.close();
```

Standalone SDK `subscribeLaunches` / `subscribeMigrations` and core
`subscribeTrades` / `subscribeTokenEvents` accept the same `source` and `sqd`
options. SDK factory defaults are inherited by its trade listener and typed
token subscription; individual calls can override them. Close a listener before
replacing it with another source. There is no silent automatic SQD→RPC fallback.
The separate browser SDK is unchanged.

## Finality and availability

- Default trade/launch/migration listeners use processed SQD blocks for lower
  latency. These observations can be orphaned; they are not confirmed receipts.
- A confirmed or finalized request uses SQD's finalized stream. Returned
  market events expose the actual `commitment`; typed token events expose
  finalized `confidence`. Live history stores that actual commitment.
- `eventSource` identifies delivery. Existing transfer `source` fields retain
  their transaction/accounting provenance and are not overwritten.
- Pump and PumpSwap trades carry `trader` and `creator` from the program's own
  trade event (`user`, coin creator). `trader` is normally the signer; a router
  program may report its own account. Other venues leave both fields absent.
- Original transaction `logIndex` identifies decoded trades across sources.
  Prefer it to legacy `eventIndex`, whose ordinal can differ when SQD omits
  unrelated logs. History and SDK duplicate suppression use the physical index
  when available. Existing stored rows are not rewritten.
- Where a venue lacks its own event timestamp, SQD uses the original block time
  (`timestampSource: "block"`), never the replay's observation time. Missing
  block time leaves that price unavailable. Old replay events cannot become
  fresh strategy prices merely because they were just downloaded.
- `source-ready` means Portal accepted the query, not that a usable market price
  has arrived. `source-progress` reports the cursor and block timestamp;
  `source-retrying` reports backoff. Existing freshness and feed verification
  guards still apply. SQD uses fresh header progress rather than trade frequency
  for the quiet-token check. Processed events keep the 30-second live window;
  finalized SQD delivery allows 120 seconds for finality. RPC guards are unchanged.
  Explicit gaps and watch changes still require `verifyAndResume` with a fresh
  on-chain state check; progress alone never clears an invalidated feed.
- A hot fork, discontinuity or invalid response emits `feed-gap-unverified`
  and closes the affected subscription. Revalidate current state and create a
  new subscription; already delivered application effects are not rolled back.
  No history-completeness claim is made.

## Transport and restart behavior

SQD coalesces watched addresses within each subscription into Portal instruction
filters, splitting each address list into at most ten cases per filter. Trade
filters are scoped to selected venue programs; launch/migration filters also use
instruction discriminators. Header-only blocks advance sparse queries. Interrupted
requests resume at the next fully delivered block; watch edits abort/rebuild
the request without skipping unread slots. HTTP 429 honors Retry-After and uses
backoff. Invalid queries/credentials fail instead of retrying as market absence.
Closing cancels requests and timers; it never closes another client's pacer.

The default dataset is **Solana mainnet**. For other clusters configure a matching
Portal dataset and metadata RPC explicitly. SQD requests use `sqd.fetch`; RPC
account reads use the existing `rpc` / `fetch` transport and pacing settings.

This is not an RPC-free SDK. Mint supply/program/decimals, verified pool identity
and quote conversion still use account reads. Typed transfer/accounting events
and some venues still fetch parsed transactions over RPC. Holder snapshots remain
authoritative; event streams do not replace them.

The cursor is in memory. A new subscription starts at the current source head
unless `sqd.fromSlot` is supplied. It does not persist an indexer's durable cursor
or provide exactly-once effects across restarts. `events(token)` canonical replay,
claims and historical provider selection retain their existing APIs; only
`events.subscribeToken(token)` is the live source-selectable event stream.

This extracts the transport boundary demonstrated by
`../solard-tradjs-landing/sqd`; that application's database, watch planning and
holder-history indexer are not copied or automatically migrated.

## Verification

```sh
bun test packages/core/src/events/log-source.test.ts packages/core/src/events/source-parity.test.ts packages/sdk/src/live.sqd.test.ts
bun run scripts/verify-sqd-source.ts
npm test
bun run test:types
```

The first tests use local fixtures. The bounded read-only script reads two
finalized mainnet blocks from the public Portal, decodes Pump events and closes;
it never opens a database, reads a wallet, uses RPC or sends a transaction.

Portal contract: https://docs.sqd.dev/en/portal/solana/api

Local verification, 2026-10-29: 608 tests pass (2,763 assertions); a fresh consumer
of the packed core/SDK archives passes strict TypeScript and runtime import.
The bounded Portal check delivered two finalized blocks and decoded five trades.
The repository-wide source typecheck still has pre-existing failures. Nothing
was published, no trading worker was restarted, and no production database or
funded operation was used.
