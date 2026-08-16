# @solard/sdk

Public Solard SDK. It intentionally contains no duplicate business logic; it re-exports the supported `@solard/core` API.

```ts
import { Solard, sol } from "@solard/sdk";

const slrd = new Solard();
const wallet = slrd.createWallet("trader-1");
const wallets = slrd.listWallets();

await slrd.tx(wallet.address).transferSol("RECIPIENT", sol("0.01")).send();
```
