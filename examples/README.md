# Solard examples

Runnable examples for the public `@solard/sdk` APIs.

All market subscription examples accept RPC configuration from `--rpc`, `RPC_ENDPOINT`, `SOLANA_RPC_URL`, or `HELIUS_RPC_URL`. They also accept an explicit WebSocket endpoint through `--ws`, `SOLANA_WS_URL`, or `HELIUS_WS_URL`.

## Market subscriptions

| Example | Purpose | Run |
| --- | --- | --- |
| `launches.ts` | Discover Pump and Raydium LaunchLab token launches | `bun run ./examples/launches.ts` |
| `migrations.ts` | Observe Pump → PumpSwap and LaunchLab migrations | `bun run ./examples/migrations.ts` |
| `trades.ts` | Follow trades for explicit token mints | `bun run ./examples/trades.ts --tokens <mint,mint>` |
| `token-metadata.ts` | Resolve normalized metadata for one mint | `bun run ./examples/token-metadata.ts <mint>` |
| `subscriptions.ts` | Compose launch → migration → trade tracking | `bun run ./examples/subscriptions.ts` |

### Metadata

Launch, migration, and trade examples accept:

```powershell
--metadata chain
--metadata full
```

Omitting `--metadata` disables enrichment.

### Mayhem

`launches.ts` and `migrations.ts` ignore Pump Mayhem tokens by default. Use:

```powershell
--include-mayhem
```

to include them.

### Launch venues

```powershell
bun run .\examples\launches.ts --venues pump
bun run .\examples\launches.ts --venues raydium-launchlab
```

### Migration filtering

Without `--tokens`, `migrations.ts` receives all supported migrations:

```powershell
bun run .\examples\migrations.ts
```

Filter to selected mints:

```powershell
bun run .\examples\migrations.ts --tokens MintA...,MintB...
```

The SDK's `MigrationSubscription.addTokens()` and `removeTokens()` only mutate an in-memory filter; they do not add per-mint RPC subscriptions.

### Trade filtering

Trades always require token mints:

```powershell
bun run .\examples\trades.ts --tokens MintA...,MintB...
```

or:

```powershell
bun run .\examples\trades.ts MintA... MintB...
```

The SDK's `TradeSubscription.addTokens()` and `removeTokens()` dynamically add/remove logical `onLogs` subscriptions on the same supplied Solana `Connection`.

## Shared WebSocket feed example

These two files demonstrate how an application can expose the SDK streams over its own WebSocket protocol:

```text
examples/price-feed-server.ts
examples/price-feed-client.ts
```

Run the server:

```powershell
bun run .\examples\price-feed-server.ts
```

Then run the demo client:

```powershell
bun run .\examples\price-feed-client.ts
```

The executable client intentionally demonstrates the broad feed. Programmatic clients can subscribe to selected mints and later mutate that selection with `client.send({ op: "subscribe", mints: [...] })` and `client.send({ op: "unsubscribe", mints: [...] })`.

The server/client protocol is example code, not an `@solard/sdk` export.

## Other examples

The repository also contains examples around history, FairFun rewards/claims, browser price streaming, backtesting, and trading strategies. Those demonstrate higher-level `createSolard()` and application workflows rather than the standalone market subscription primitives.

For the complete public SDK reference, see [`../packages/sdk/README.md`](../packages/sdk/README.md).
