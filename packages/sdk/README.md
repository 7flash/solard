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
