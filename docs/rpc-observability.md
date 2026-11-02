# RPC observations

Register early, before creating clients:

```ts
import { observeSolardRpc, withSolardRpcContext } from '@solard/sdk';
const stop = observeSolardRpc(event => { /* enqueue metadata */ });
await withSolardRpcContext({ wallet: 'my-wallet', mint, stage: 'quote' },
  () => sdk.samplePrice(mint));
stop();
```

Observers are additive and process-wide. Callback failures cannot change trade execution. `rpc` measures the complete standard web3 operation, including response-body reading and JSON decoding; `http` measures each physical attempt until response headers; `request` covers the raw transport. Parent IDs connect these records. Queue and network phases distinguish admission/backoff from provider work.

Events contain sanitized endpoints and timing/context metadata. They exclude request parameters, payloads, signed bytes, credentials and raw error messages. Solard connections and its instrumented HTTP/history/Jito transports are covered. Arbitrary fetches, third-party connections and WebSocket frames are not monkeypatched.

The allocation manager persists observations through a Bun worker into `.range-bots/observability.sqlite`, separately from financial journals. The queue holds 2,000 events, flushes every 100 ms and retains about 20,000 completed records. Recorder health exposes dropped events and storage errors. Forced shutdown can lose buffered telemetry; an unobserved request never establishes a trade outcome.

The local console's `/rpc` page reads this store without making chain RPC calls.
