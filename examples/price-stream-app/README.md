# Solard price stream example

A small browser application that consumes the shared Solard market feed through the browser-safe `@solard/sdk/browser/price-feed` entry.

It intentionally subscribes to `launches: true` and `allPrices: true`. It does not call `watchPrice()` for every discovered mint, so opening the dashboard does not create hundreds of explicit-mint fallback subscriptions.

## 1. Start the shared feed

From the repository root:

```powershell
slrd feed serve --rpc-rps 5 --rpc-read-rps 2
```

or without a linked CLI:

```powershell
bun run .\packages\solard-cli\bin\solard.ts feed serve --rpc-rps 5 --rpc-read-rps 2
```

The root compatibility shim also supports:

```powershell
bun run .\bin\solard.ts feed serve --rpc-rps 5 --rpc-read-rps 2
```

The normal feed WebSocket is `ws://127.0.0.1:8788/ws`.

## 2. Start the example app

```powershell
bun run .\examples\price-stream-app\server.ts
```

Open `http://127.0.0.1:4180`.

The browser bundle imports only the dedicated price-feed SDK module. It does not bundle Solard persistence, SQLite, readline, wallet code, or the server-side core.
