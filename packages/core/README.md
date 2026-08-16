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
