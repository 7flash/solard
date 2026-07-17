# SOWL

**Multi-wallet Solana CLI + SDK for traders and AI agents**

SOWL is a production-oriented toolkit for operating many Solana wallets as a coordinated agent. It is built around a small, plugin-based kernel that can quote, buy, sell, claim value, launch tokens (primarily on the pump.fun family of venues), and compose higher-level workflows, while keeping a full local history of every execution, position, and price sample.

A web terminal (“Solard”) is included for live monitoring, watchlists, portfolio views, launch jobs, and signal ingestion.

## Core Capabilities

- **Wallet & group management**
  - Import private keys (base58 or JSON byte arrays)
  - Encrypted at rest with `SOWL_MASTER_KEY`
  - Named wallets + weighted groups for coordinated multi-wallet actions
  - Balance inspection (SOL + registered tokens)

- **Token lifecycle**
  - Register any mint, attach metadata, refresh on-chain state
  - Launch on pump-style launchpads (create + optional creator buy)
  - Automatic venue routing (pump curve → pumpswap, etc.)

- **Trading primitives**
  - `buy` / `sell` / `quote` / `price` with configurable slippage
  - Single wallet, multi-wallet, or whole-group execution
  - Multiple send lanes: plain RPC, Helius, Jito bundles
  - Simulation-first by default; explicit live flag required for real sends

- **Claims & workflows**
  - Pluggable claim sources (creator fees, cashback, staking rewards, …)
  - Ready-made workflows such as `claim-trade-send` and `wait-launch-trade-group`
  - Easy to add new compositions as scripts or workflow plugins

- **Observability & history**
  - Every transaction is recorded with actions, simulation results, and status
  - Local price samples + simple SMA windows
  - Position tracking (holdings + average entry)
  - Address lookup tables (ALTs) support for large transactions

- **Web terminal (Solard)**
  - Live pump feed (Helius / PumpPortal)
  - Watch groups, quick-buy from the terminal, portfolio, signals (Telegram + manual)
  - Launch job runner with logs and status
  - Connection strip, toasts, and measured client-side tracing

- **Extensibility**
  - Venue, ClaimSource, LaunchSource, Launchpad, and Sender registries
  - External scripts via `sowl run <name-or-path>`
  - Agent configuration surface for longer-running actors

## Quick Start

```bash
# Install (Bun recommended)
bun install

# Required environment
export SOWL_MASTER_KEY="your-long-random-secret"
export RPC_ENDPOINT="https://..."          # or HELIUS_RPC_URL / HELIUS_API_KEY
# Optional but recommended for production lanes
export HELIUS_SENDER_URL="..."
export HELIUS_TIP_ACCOUNT="..."
export JITO_BLOCK_ENGINE_URL="https://mainnet.block-engine.jito.wtf"

# Import a wallet
sowl import <private-key-base58-or-json> bgmu

# Register a token
sowl token <mint> MyToken

# Dry-run a buy
sowl buy <mint> --wallet bgmu --sol 1 --simulate-only

# Live buy (only after you have set SOLARD_ENABLE_LIVE_TRADES=1 or the equivalent live flag)
sowl buy <mint> --wallet bgmu --sol 0.05 --sender helius-fast --slippage-bps 1500
```

### Useful one-liners

```bash
# List wallets + balances
sowl wallets

# Group operations
sowl group create snipers
sowl group add-many snipers wallet1,wallet2,wallet3
sowl buy <mint> --group snipers --sol 0.1 --sender jito

# Price sampling
sowl price <mint>
sowl price watch <mint1> <mint2> --interval 2s --period 5m

# Launch (pump)
sowl launch pump --creator <wallet> --image ./img.png --description "..." --live

# History
sowl history
```

## Architecture (first principles)

```
┌─────────────────────────────────────────────────────────────┐
│  Interfaces                                                 │
│  • CLI (sowl …)                                             │
│  • Web terminal (Solard)                                    │
│  • Scripts (sowl run …)                                     │
│  • Agents                                                   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Kernel (Sowl class)                                        │
│  • resolve wallet / token / group                           │
│  • route to Venue / ClaimSource / Launchpad                 │
│  • TransactionComposer / BatchComposer                      │
│  • simulate → send → confirm → persist                      │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   Venues & Claims    Launches & Jobs     Persistence
   (plugins)          (plugins)           (SQLite + repos)
```

Everything that touches the chain goes through the same simulation + execution path. Strategies and higher-level behaviours live outside the kernel as scripts or workflow plugins.

## Safety Model

- Simulation is the default for every transaction builder.
- Real (live) sends require an explicit environment flag (`SOLARD_ENABLE_LIVE_TRADES=1` or the equivalent checked by the web/CLI layer).
- All private keys are encrypted at rest; the master key is never written to the database.
- Secrets are redacted in logs.
- Jito and Helius tip / priority settings are configurable and can be forced to zero for pure dry-runs.

Treat the live flag as a physical switch. Keep it off until you have verified the exact mint, wallet, amount, and sender you intend to use.

## Environment Variables (most important)

| Variable                    | Purpose                                      |
|-----------------------------|----------------------------------------------|
| `SOWL_MASTER_KEY`           | Required for import / signing of stored wallets |
| `RPC_ENDPOINT` / `HELIUS_RPC_URL` / `HELIUS_API_KEY` | Chain access                 |
| `HELIUS_SENDER_URL`         | Fast Helius sender endpoint                  |
| `HELIUS_TIP_ACCOUNT`        | Tip account for helius-fast                  |
| `JITO_BLOCK_ENGINE_URL`     | Jito block engine                            |
| `SOWL_DB_PATH`              | SQLite location (default `./sowl.db`)        |
| `SOLARD_ENABLE_LIVE_TRADES` | Master switch for real sends                 |
| `SOWL_CACHE_TTL_MS`         | Account cache TTL                            |
| `SOWL_TRACE`                | Enable human-readable progress tracing       |

## Development & Scripts

```bash
# List registered scripts
sowl scripts

# Run a script (looks in sowl.config.ts or ./scripts/)
sowl run snipe --name ExactTokenName --group snipers --sol 0.05 --sender jito

# Example external script pattern
# scripts/repeat-buy.ts
import { createTraderSowl } from "../src/presets/trader.js";
// … use sowl.buy in a loop with sleep
```

The recommended way to add new strategies is to keep them as thin scripts that import the SDK. The kernel itself stays free of hard-coded trading logic.

## Project Layout (high level)

```
src/
  core/          # amounts, errors, keypair crypto, logging, refs
  chain/         # connection, blockhash, simulate, state readers
  tx/            # transaction builder, composer, senders, types
  db/            # schema, repos, maintenance
  venues/        # TradeVenuePlugin implementations + routing
  claims/        # ClaimSourcePlugin registry
  launches/      # LaunchSource + Launchpad plugins (pump, …)
  workflows/     # claim-trade-send, wait-launch-trade-group, …
  sdk/           # the Sowl class (kernel)
  cli.ts         # CLI entrypoint
  web/           # Solard web terminal + API
  runtime/       # agents, positions, watcher
  bank/          # (legacy / optional deposit-wallet surface)
```

## Current Focus & Roadmap Notes

- The CLI buy path is the primary, well-tested surface for single- and multi-wallet purchases of already-deployed tokens.
- Repeated / timed buys are currently expressed as simple shell loops or short scripts; a first-class `--repeat` / timed-buy helper is a natural next addition.
- Cleanup targets (duplicated measured helpers, unused bank surface, clearer package boundaries) are intentionally small and non-breaking.
- The web terminal is intentionally feature-rich for live ops; the kernel remains usable without it.

## License & Contribution

Internal / private use. Treat the live-trading path with the same care you would give any system that can move real SOL and tokens.

---

**Philosophy**

SOWL is deliberately built from the same first principles that good electronics and good agent design share: clear entities, explicit state transitions, measurable effects, and the ability to compose larger behaviours from small, reliable primitives. Keep the kernel simple; put the cleverness in the plugins and the scripts.
