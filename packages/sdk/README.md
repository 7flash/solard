# @solard/sdk

Public Solard SDK. It intentionally contains no duplicate business logic; it re-exports the supported `@solard/core` API.

```ts
import { createSolard } from "@solard/sdk";

const slrd = createSolard();
await slrd.addToken(mint, undefined, { venueHint: "pumpswap", pool: poolAddress });
const buy = await slrd.buy(
  { wallet: "trader-1", token: mint, amount: { sol: 0.001 }, slippageBps: 500 },
  { intentKey: "example:buy:1", priorityFee: { cuLimit: 600_000, microLamports: 200_000 } },
);
if (buy.status === "confirmed") {
  console.log(buy.solPrincipalDeltaLamports, buy.networkFeeLamports, buy.targetTokenDeltaRaw);
}
// Sell through the same atomic quote-token -> SOL route.
// await slrd.sell({ wallet: "trader-1", token: mint, amount: "all", slippageBps: 500 });
```

The trader preset supports Pump/PumpSwap, Meteora DBC and DAMM v2. Custom quote
routes require a supported SOL market for the quote token and suitable lookup
tables when needed. Composer routes fall back to Jupiter instructions. Unavailable
converted prices are null. `unresolved` means reconcile with `resumeTrade(intentKey)`
before another trade. Buy accepts `minOutputRaw`; sell accepts `minOutputLamports`.
Both use confirmed/failed/unresolved results with phase, code, attempts and accounting.
`quote`, `curveLiquidity`, `maxSendableSol`, `transferToken` and `exitWallet` share the
core implementation. Raydium AMM/CPMM execution does not supply live pool prices.

In 0.2.32, sell an exact positive integer number of raw token units with the
object API. For a six-decimal mint, `"1000000"` is one token:

```ts
const sold = await slrd.sell(
  { wallet: "trader-1", token: mint, amountRaw: "1000000", slippageBps: 500 },
  { intentKey: "example:sell:1", priorityFee: { cuLimit: 200_000, microLamports: 20_000 } },
);
```

`amountRaw` also accepts bigint and is mutually exclusive with `amount`.
An economic sell guard rejects output at or below the selected network fee plus
tip before broadcasting, with `UNECONOMIC_SELL`. Its `sellEconomics` fields describe
the expected output and selected costs; they are not charges already paid.
`networkFeeLamports` is the actual on-chain charge only when known. Selected
priority cost reserves the chosen CU limit, so it differs from consumed CUs.

The configured client inherits its database path and RPC endpoints for listeners.
Live history is recorded by default; disable recording with `history: false`:

```ts
const slrd = createSolard({ dbPath: "./slrd.db", rpcUrl });
const listener = await slrd.listenTrades({ tokens: [mint] });
listener.onTrade((event) => console.log(event));
// await slrd.listenTrades({ tokens: [mint], history: false });
await listener.close(); // Wait for queued history writes to flush.
```

The collected live tail is partial history, not a complete backfill. Processed
events can later disappear; `slrd.historicalTape(mint)` excludes them by default.
Pass `{ includeProcessed: true }` to inspect that provisional tail and check the
returned completeness information before using it for backtests.
