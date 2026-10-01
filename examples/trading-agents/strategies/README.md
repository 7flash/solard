# Strategy design

Every current strategy is dynamically imported by `trader.ts` and receives the latest cached market values plus its own in-memory state. It returns only `"buy"`, `"sell"`, or `null`.

The trader owns execution. `"buy"` spends the full `--budget`. `"sell"` sells the full token position with `amount: "all"`.

## Reference strategy

`market-cap-cross.ts` is the minimal reference strategy. Its thresholds come from trader CLI arguments:

```powershell
bun examples/trading-agents/trader.ts --mint <mint> --strategy market-cap-cross --wallet <wallet> --budget 0.1 --buy-mcap 50000 --sell-mcap 100000
```

The trader passes all parsed flags to the selected strategy, so strategy-specific arguments do not need to be added to `trader.ts`. The first observed market cap only establishes the previous value and does not trigger a trade by itself.

## Strategies that fit the current buy/sell contract

- Price cross: buy or sell when price crosses fixed levels.
- Market-cap cross: buy or sell when market cap crosses fixed levels.
- Breakout: buy above a rolling high; sell below a rolling low or at an exit target.
- Pullback/dip: buy after a configured drawdown from a recent high.
- Momentum: buy when short-window price velocity exceeds a threshold.
- Mean reversion: buy below a rolling mean/band and sell after reversion.
- Range: buy near the lower edge of a range and sell near the upper edge.
- Take-profit/stop-loss: enter from another signal and exit at fixed percentages from entry.
- Trailing exit: maintain a post-entry high and sell after a configured retracement.
- Moving-average cross: use fast/slow SMA or EMA crossovers.
- Volatility breakout: scale trigger distance from rolling realized volatility.
- Multi-timeframe confirmation: require aligned short- and long-window signals.
- Volume/activity confirmation: require trade count or volume conditions before a price signal is accepted.
- Order-flow imbalance: use recent buy/sell flow imbalance as an entry or exit signal.
- Liquidity/reserve signal: use pool/curve liquidity, reserve changes, or bonding-curve progress.
- Time-based: enter/exit after elapsed time, token age, or session windows.
- Launch/migration event: react to launch, graduation, migration, or venue-transition events.
- Relative-strength: compare the token with SOL or another benchmark before entering.
- Wallet-follow/copy signal: react to observed trades from selected wallets.
- Composite state machine: combine several of the above into explicit phases such as waiting, armed, holding, and exiting.

## Strategies that need a richer execution action later

These do not fit cleanly into the current full-budget buy/full-position sell contract:

- DCA or laddered entries.
- Scale-in on successive signals.
- Partial take-profit or staged exits.
- Position sizing based on volatility or confidence.
- Rebalancing to a target token/SOL weight.
- Multiple simultaneous token positions with shared capital.
- Portfolio ranking and capital rotation.
- Limit-order/grid strategies.
- Market making.
- Hedged or paired trades.

For those, the strategy return type should eventually grow from `"buy" | "sell" | null` into a small action object carrying side and size. Until then, keep the reference examples binary and deterministic.
