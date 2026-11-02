# One process for all CSV rows

## Prepared orders and threshold hold

Targets mean the spot price before our order. The whole fill may cross that price due to our own impact and protocol fees. Preparation projects the target pool to the trigger boundary, quotes the full size using venue fee rules, and encodes the resulting minimum. It never derives a permissive floor from a distant earlier spot. Custom quotes retain verified conversion and per-leg protections.

Additional adverse movement is `min(200bps, floor(relative target spread × shareBps))`, where relative spread is `(sell-buy)/buy` and `--range-slippage-share-bps` defaults to 1000 (10% of the spread). Examples: 100/105 allows 50bps (0.5%); 540000/580000 allows 74bps (0.74%); 100/120 reaches the 200bps (2%) cap. Crossed exit-only bounds have zero positive-spread allowance. Lower the share or set it to zero to tighten it. The cap is enforced by core, not only the CLI.

The trigger now consumes a fresh prepared Pump/PumpSwap transaction. Route lookup, quotes, balance/rent checks, fee selection and signing run in the background. It skips both local simulation and sender preflight; on-chain limits remain mandatory. Unsupported final-output routes report `NO_PREPARED_ROUTE`. There is no slow foreground build fallback.

Amounts and output floors stay fixed within each prepared order. Instructions refresh at most every 15 seconds, with fresh blockhash/signature and balance checks between route refreshes. Exact signed-byte readiness expires within five seconds; unavailable/expired preparation waits and is logged. A USD market-cap limit can generate a new SOL floor when verified supply or SOL/USD changes. Edits invalidate older readiness.

`--hold-ms 2000` requires fresh qualifying observations spanning two seconds before submitting. Default `0` submits immediately when triggered and ready. An observed recross, stale/failed sample or changed limits resets the hold. Sampling defaults to 1000ms; it cannot observe moves between samples. The hold reduces short-lived triggers, but a transaction can still fail and pay fees if the market changes before landing.

Fees are configurable using `--priority-micro-lamports` (default 20000) and `--cu-limit` (default 600000). Background RPC demand must fit the provider quota. The bot logs `trigger-to-submit` through RPC acknowledgement separately from settlement. Neither readiness nor subsecond live submission/confirmation is guaranteed. Existing pending-signature reconciliation and same-byte rebroadcast protections remain. No workers were restarted for this change.

Run `bun run range-bots.ts --ranges-csv ranges.csv --amount 0.1 --interval 5000 --rpc-url https://solana-rpc.publicnode.com` to manage all rows in one process. It watches the CSV once and starts a token loop for each new valid wallet/mint row, using the runner's buy size (currently 0.1 SOL).

Removing or invalidating a row pauses its new decisions, preserves its position and pending transaction, and continues reconciliation. Removal does not sell anything. Restoring the row resumes it. A failed startup is reported without stopping other loops; edit its limits to retry it.

Loops share one SDK, database handle and SOL/USD cache. Same-wallet SDK trades serialize while sampling continues. Failed USD requests share a 30-second backoff; stale timestamps are preserved and trading pauses beyond the existing 120-second freshness bound. Existing per-token states and histories are reused. Do not run standalone workers for the same wallet/mint alongside this manager.

Execution logs split balance/rent checks, transaction simulation, sender broadcast and settlement/accounting. These are measured stages, not a latency guarantee. Submission reuses the fee verified for the same message by the balance preflight; simulation and on-chain minimum-output protection remain enabled.

For Pump curves, a trade immediately following a sample may reuse that chain-validated full curve state for up to one second. Cache hits cannot extend that age; token metadata changes or migration invalidate reuse. This skips a reserve RPC, not exact-amount output/fee calculations. PumpSwap still uses its SDK state and fee requirements; a spot-price ratio alone is not an executable quote.

## Shared range settings

The active bots read `ranges.csv`. Edit and save the two numeric USD market-cap columns; no restart is needed after this migration.

```csv
wallet,mint,buy_mcap_usd,sell_mcap_usd
ddm6,YOUR_MINT,44000,73000
```

Amounts are dollars, so enter `44000` for $44k, with no dollar signs or thousands separators. Keep wallet and mint unchanged. Buy must be positive and sell greater than buy. Reordered columns, quoted cells, CRLF and UTF-8 BOM saves are supported.

Use `--ranges-csv ranges.csv`. Each process selects exactly one row matching its wallet and mint. Missing/duplicate rows or invalid bounds pause that bot's new decisions; other valid rows continue. Structurally malformed CSV or invalid headers pause all readers until corrected. Sampling and pending reconciliation continue. Existing submitted/preparing trades retain their captured limits. Editing or adding a row does not launch a new worker, change buy size, close a position, or cancel a transaction.

```powershell
bun run range-trade.ts --mint YOUR_MINT --wallet ddm6 --ranges-csv ranges.csv --check-config
```

The per-token JSON files below remain supported for compatibility; migrated live workers use only the CSV.

## Fixed buy/sell price bot

`range-trade.ts` uses two fixed SOL-per-token prices. It buys at or below the lower price, holds its recorded position, then sells at or above the upper price. After a confirmed sell it waits for the next buy. No SMA warmup is needed, but a fresh verified SOL price is required. Failed builds/simulations execute nothing; uncertain submitted transactions still reconcile before another attempt.

Example (illustrative prices, not a recommendation):

```powershell
bunx bgrun --name range-example --command "bun run range-trade.ts --mint YOUR_MINT --wallet ddm6 --amount 0.1 --buy-price-sol 0.000001 --sell-price-sol 0.0000012 --interval 5000 --rpc-url https://solana-rpc.publicnode.com" --directory C:/Code/solwal --config .config.toml
```

This example triggers a 0.1 SOL buy at spot at/below 0.000001 SOL/token and an exact-position sell at spot at/above 0.0000012 SOL/token. Its 20% target spread permits the capped 2% additional slippage, separately from modeled own impact/protocol fees. Network fees, rent and tips are separate; the spread is not guaranteed net profit. The raw on-chain output floor remains enforced if conditions change before landing.

Both prices must be positive and sell must exceed buy. Decimal/scientific notation accepted. Fixed prices remain unchanged while the bot runs; it does not recalculate them from SMA. No extra entry-cost profit floor is added to the specified sell price.

It is standalone and stores its own position/pending state in `.range-bots/bot-<wallet>-<mint>.json` and its own journal under `.range-bots/bot-history/`. It does not import or change `trade.ts`. Only the per-wallet/mint PID exclusion lock is shared with the SMA bots. Do not run an SMA bot and a fixed bot for the same wallet/mint simultaneously. Existing SMA positions are not imported into the range bot. The range bot resumes only its own saved position and pending request. The script publishes its own CSV history using the configured Solard database; do not change databases while a position or request is pending. Never delete a pending request or PID lock for a running process.

No fixed-price live worker was started when this script was added. Supply your mint and two prices before launching.

## Edit prices while running

Use `--range-file range.example.json` instead of the two inline price flags:

```json
{
  "buyPriceSol": "0.000001",
  "sellPriceSol": "0.0000012"
}
```

```powershell
bunx bgrun --name range-example --command "bun run range-trade.ts --mint YOUR_MINT --wallet ddm6 --amount 0.1 --range-file range.example.json --rpc-url https://solana-rpc.publicnode.com" --directory C:/Code/solwal --config .config.toml
```

Save that file to update future decisions. The entire pair is validated together; reversed prices, invalid JSON, deleted files or additional properties suspend new trade decisions until corrected. Sampling and pending-transaction reconciliation continue. A transaction already in preparation/submission retains the original captured limits; a file edit cannot recall it. A later attempt/decision uses the latest valid pair.

Uses Bun's supported `fs.watch` directory watcher to survive atomic editor saves, debounced; also validates at each decision in case a filesystem event was missed. No HTTP server, open port or externally reachable control API. Watchers start only when you explicitly run the script and close on script shutdown.

Independent outputs: `.range-bots/bot-positions.json`, `.range-bots/bot-trades.csv` and `.range-bots/bot-history/<wallet>-<mint>.csv` / `.jsonl`. Separate order namespace prevents collisions with current SMA bots. No current bot was switched or restarted.

Validate without starting a watcher, reading wallet secrets, making RPC calls or trading:

```powershell
bun run range-trade.ts --mint YOUR_MINT --wallet ddm6 --range-file range.example.json --check-config
```

Bun watcher reference: https://bun.sh/guides/read-file/watch (Bun implements `fs.watch`; no invented `Bun.watch` API).

Price samples wake the decision loop immediately on arrival. The five-second sampling interval does not add a second five-second wait before quoting. Samples arriving during trade/reconciliation work are consumed on the next decision without losing the notification. A protected buy can still be rejected when the executable quote exceeds the range ceiling.
