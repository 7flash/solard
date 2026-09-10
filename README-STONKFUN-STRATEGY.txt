Solard StonkFun/Raydium strategy pack

Contains:
- target-weight controller/backtester/agent (40% target, 3pp outer / 1pp inner hysteresis supported)
- interactive value-band live agent using executable Jupiter quotes for Raydium/StonkFun tokens
- Raydium history backfill script with Helius getTransactionsForAddress fast path and standard RPC fallback
- Raydium strategy comparison: hold vs value-band vs target-weight vs ATH-dip

Examples:

1) Backfill a Raydium/StonkFun token:
  slrd run examples/raydium-history-backfill.ts --token <MINT>

  Optional explicit pool:
  slrd run examples/raydium-history-backfill.ts --token <MINT> --pool <RAYDIUM_POOL>

2) Compare strategies against the produced JSONL:
  slrd run examples/raydium-strategy-suite.ts --trades <PATH_TO_trades.jsonl> --capital-sol 5 --base-sol 0.1

3) Dry-run the value-band agent:
  slrd run examples/value-band-trading-agent.ts --token <MINT> --wallet pumpfun --base-sol 0.1 --loop --dashboard

4) Live:
  set SOLARD_ENABLE_LIVE_TRADES=1
  slrd run examples/value-band-trading-agent.ts --token <MINT> --wallet pumpfun --base-sol 0.1 --loop --dashboard --live

Dashboard controls:
  +  increase target exposure
  -  decrease target exposure
  s  scale toward the currently selected target now
  q  quit

The measure-fn logger is middleware: dashboard mode writes structured events to a JSONL log file while suppressing built-in terminal logging so the screen can display current state. Non-dashboard mode calls next() and keeps the standard measure-fn terminal output while still accumulating the same events in the log file.
