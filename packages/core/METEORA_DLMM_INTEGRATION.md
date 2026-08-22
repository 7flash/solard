# Meteora DLMM + stateless agent tools

Solard exposes Meteora DLMM through `slrd.meteora` and provider-neutral function tools through `slrd.agent(...)`.
The SDK is intentionally capability-oriented: it owns protocol/data access, transaction preparation, simulation and execution boundaries. It does **not** own pool scoring, autonomous loops, lessons, LLM prompts or portfolio policy.

## Runtime dependencies

Ensure the `packages/core` package has direct dependencies on:

```text
@meteora-ag/dlmm
bn.js
```

The Meteora SDK is loaded lazily, so processes that never use DLMM do not initialize it.

## Environment

```text
METEORA_DLMM_CLUSTER=mainnet-beta
METEORA_DLMM_DATA_API_URL=https://dlmm.datapi.meteora.ag
METEORA_POOL_DISCOVERY_API_URL=https://pool-discovery-api.datapi.meteora.ag

# Optional read-only GMGN tools
GMGN_API_KEY=...
GMGN_API_URL=https://openapi.gmgn.ai
SOLARD_EXTERNAL_HTTP_TIMEOUT_MS=10000
```

The GMGN client deliberately supports only API-key/read endpoints. It has no GMGN private-key or signed-order implementation.

## Direct Meteora service

### Pool and market data

- `searchPools(query, limit)`
- `discoverPools({ pageSize, timeframe, category, filterBy })`
- `getPoolDetail(pool, timeframe)`
- `getIndexedPool(pool)`
- `getPoolState(pool, refresh)`
- `getActiveBin(pool, refresh)`
- `getPoolOhlcv(pool, { timeframe, startTime, endTime })`
- `getPoolVolumeHistory(pool, { timeframe, startTime, endTime })`
- `listPoolGroups(...)` / `getPoolGroup(...)`
- `getProtocolMetrics()`
- `getDailyProtocolFees()` / `getDailyTradingFees()` / `getDailyVolume()`

### Bin helpers

- `getBinsAroundActiveBin`
- `getBinsBetween`
- `getBinsByPrice`
- `getBinIdFromPrice`
- `getBinIdFromPricePerLamport`

### Portfolio and positions

- `getPortfolio(...)`
- `getOpenPortfolio(...)`
- `getPortfolioTotal(wallet)`
- `getMyPositions(walletRef)`
- `getWalletPositions(walletAddress)`
- `getWalletPositionsForToken(walletAddress, tokenMint)`
- `getPoolPositions(pool, walletAddress)`
- `getPosition(pool, position)`
- `findPoolForPosition(position, walletAddress)`
- `getPositionHistory(position, ...)`
- `getPositionPnl(...)`
- open/closed limit-order pool and order queries
- limit-order summary/bonus-claimed queries
- wallet/pool accumulated claims

Read-only wallet analytics use the wallet's public address and do not require loading the signer.

### Position lifecycle

Each write has a build/preparation path and an execution path:

- open position
- add liquidity
- remove liquidity
- close position
- claim fees/rewards (single position and bulk)
- exact-in / exact-out swaps

Meteora transaction helpers accept Solard-style BPS values where appropriate and normalize them to the units expected by the SDK.

## Agent tool facade

```ts
const agent = slrd.agent("research", "wallet:bank");

const catalog = agent.meteoraTools();
const candles = await agent.runMeteoraTool("meteora_get_pool_ohlcv", {
  pool_address: pool,
  timeframe: "1h",
});
```

`agent.tools()` returns the combined tool catalog and `agent.runTool(...)` dispatches by tool name. This catalog contains deterministic protocol/data capabilities only; it does not include autopilot or intelligence-policy tools.

Meteora mutations are prepare-only unless the call explicitly opts into execution. Live broadcast requires both `execute: true`, `live: true`, and Solard's server live-trading switch. Simulation is on by default and RPC preflight is not skipped by default.

## Optional GMGN research facade

```ts
const security = await agent.runGmgnTool("gmgn_token_security", {
  chain: "sol",
  address: tokenMint,
});

const holders = await agent.runGmgnTool("gmgn_token_holders", {
  chain: "sol",
  address: tokenMint,
  limit: 20,
});
```

The exposed GMGN surface covers token info/security/pools, holders/traders, K-lines, trending, Trenches, token signals/hot searches, public wallet stats/activity, KOL/Smart Money lists, creator history, gas fee tiers and quote-only routes. Fee-related observations can come from fields GMGN already exposes, such as launchpad `fee_distribution`, rank `gas_fee`, Trenches fee fields, and signal `total_fee` filters; Solard does not invent a separate fee metric.

## Example policy composition

See `examples/meteora-dlmm-agent.ts`. It demonstrates how an application can compose these stateless tools into screening logic. The thresholds are explicitly example-only and the “model” hook is a deterministic mock; no LLM dependency is introduced into Solard core.

## Native CLI

The human CLI calls `slrd.meteora` directly; it does not require a persistent agent name.

```bash
slrd meteora discover --timeframe 30m --sort fee-active-tvl --limit 20
slrd meteora pools --timeframe 30m --sort fee-tvl --limit 20
slrd meteora pool <pool>
slrd meteora candles <pool> --timeframe 5m
slrd meteora positions --wallet main
slrd meteora open <pool> --wallet main --sol 0.1 --bins 40 --strategy spot
```

`discover` uses the Pool Discovery API and exposes `active_tvl` / `fee_active_tvl_ratio`. `pools` uses the indexed DLMM Data API and exposes `tvl` / `fee_tvl_ratio`. Keeping those commands distinct prevents the two ratios from being treated as interchangeable.

Position and swap writes are prepare-only by default from the CLI. `--live` performs the build, simulation, preflight and broadcast in the same invocation, subject to Solard's normal live-trading gate.
