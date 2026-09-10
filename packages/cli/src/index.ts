#!/usr/bin/env bun
import {
  addExternalContact,
  configureSolardMeasure,
  createSolardMeasureCollector,
  executeRegistrySolSweep,
  executeRegistryTokenLiquidation,
  findExternalContact,
  getSolardRpcStats,
  listExternalContacts,
  loadWalletAssetPortfolio,
  planRegistrySolSweep,
  planRegistryTokenLiquidation,
  removeExternalContact,
  resetSolardRpcStats,
  resolveTokenMintForPolicy,
  runScript,
  listScripts,
  simulateRegistrySolSweep,
  simulateRegistryTokenLiquidation,
  wrappedSolAta,
  type TokenRow,
} from "@solard/sdk";

import { handleMeteoraCommand } from "./meteora-commands.ts";
import { resolveDestinationRef } from "./refs.ts";
import {
  VaultOnboardingError,
  cliVaultStatus,
  ensureCliVaultReady,
  loadRememberedCliVault,
} from "./vault-onboarding.ts";

function emit(value: string): void {
  process.stdout.write(value);
}

const OWL = "🦉";
const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";
const CANONICAL_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type Flags = Map<string, string>;
function args(input: string[]): { values: string[]; flags: Flags } {
  const values: string[] = [],
    flags = new Map<string, string>();
  for (let i = 0; i < input.length; i++) {
    const current = input[i]!;
    if (current === "-w") {
      flags.set("wallet", input[++i] ?? "");
      continue;
    }
    if (current.startsWith("--")) {
      const [key, inline] = current.slice(2).split("=", 2);
      if (inline != null) flags.set(key!, inline);
      else if (input[i + 1] && !input[i + 1]!.startsWith("-"))
        flags.set(key!, input[++i]!);
      else flags.set(key!, "true");
      continue;
    }
    values.push(current);
  }
  return { values, flags };
}
function need(flags: Flags, key: string): string {
  const value = flags.get(key);
  if (!value || value === "true") throw new Error(`Missing --${key} <value>`);
  return value;
}
function int(flags: Flags, key: string, fallback?: number): number | undefined {
  const value = flags.get(key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${value}`);
  return parsed;
}
function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}
function formatError(error: unknown): string {
  if (error instanceof Error) {
    const code =
      "code" in error &&
      typeof (error as Error & { code?: unknown }).code === "string"
        ? ` [${String((error as Error & { code?: unknown }).code)}]`
        : "";
    const message = error.message.trim();
    const summary = `${error.name}${code}${message ? `: ${message}` : " (no message)"}`;
    return error.stack && error.stack !== summary
      ? `${summary}\n${error.stack}`
      : summary;
  }
  try {
    const encoded = json(error);
    return encoded && encoded !== "undefined" ? encoded : String(error);
  } catch {
    return String(error);
  }
}

function friendlyCliError(error: unknown): string | null {
  const debug =
    process.argv.includes("--debug") ||
    process.env.SLRD_DEBUG === "1" ||
    process.env.SOLARD_DEBUG === "1";
  if (debug || !(error instanceof Error)) return null;
  const code =
    "code" in error &&
    typeof (error as Error & { code?: unknown }).code === "string"
      ? String((error as Error & { code?: unknown }).code)
      : null;
  if (error instanceof VaultOnboardingError) return error.message;
  if (code === "MISSING_CONFIG" && error.message.includes("SLRD_MASTER_KEY")) {
    return `${error.message}\n\nRun \`slrd setup\` in an interactive terminal, or set SLRD_MASTER_KEY for automation/CI.`;
  }
  return null;
}
function duration(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(value.trim());
  if (!match)
    throw new Error(`Invalid duration: ${value}. Use e.g. 500ms, 5s, 15m, 1h.`);
  const n = Number(match[1]);
  const scale = ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const)[
    (match[2]?.toLowerCase() ?? "ms") as "ms" | "s" | "m" | "h"
  ];
  return Math.floor(n * scale);
}

function txAccountKeys(tx: any): string[] {
  const message = tx?.transaction?.message;
  if (!message) return [];
  const toStringKey = (value: any): string => {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (typeof value?.toBase58 === "function") return value.toBase58();
    if (typeof value?.pubkey?.toBase58 === "function")
      return value.pubkey.toBase58();
    if (typeof value?.pubkey === "string") return value.pubkey;
    return String(value);
  };
  if (Array.isArray(message.accountKeys))
    return message.accountKeys.map(toStringKey);
  if (Array.isArray(message.staticAccountKeys)) {
    const keys = message.staticAccountKeys.map(toStringKey);
    const loaded = tx?.meta?.loadedAddresses;
    if (Array.isArray(loaded?.writable))
      keys.push(...loaded.writable.map(toStringKey));
    if (Array.isArray(loaded?.readonly))
      keys.push(...loaded.readonly.map(toStringKey));
    return keys;
  }
  try {
    if (typeof message.getAccountKeys === "function") {
      const accountKeys = message.getAccountKeys({
        accountKeysFromLookups: tx?.meta?.loadedAddresses,
      });
      const keys: string[] = [];
      for (let i = 0; i < Number(accountKeys?.length ?? 0); i += 1)
        keys.push(toStringKey(accountKeys.get(i)));
      return keys;
    }
  } catch {}
  return [];
}

function txWalletTokenBalances(
  tx: any,
  owner: string,
): Map<string, { decimals: number; pre: bigint; post: bigint }> {
  const out = new Map<
    string,
    { decimals: number; pre: bigint; post: bigint }
  >();
  const add = (side: "pre" | "post", rows: any[] | null | undefined) => {
    for (const row of rows ?? []) {
      const rowOwner =
        typeof row?.owner === "string"
          ? row.owner
          : typeof row?.owner?.toBase58 === "function"
            ? row.owner.toBase58()
            : "";
      if (rowOwner !== owner || typeof row?.mint !== "string") continue;
      const amount = row?.uiTokenAmount?.amount;
      const decimals = Number(row?.uiTokenAmount?.decimals ?? 0);
      if (typeof amount !== "string" || !/^\d+$/.test(amount)) continue;
      const existing = out.get(row.mint) ?? { decimals, pre: 0n, post: 0n };
      existing.decimals = decimals;
      existing[side] += BigInt(amount);
      out.set(row.mint, existing);
    }
  };
  add("pre", tx?.meta?.preTokenBalances);
  add("post", tx?.meta?.postTokenBalances);
  return out;
}

function formatRawLocal(value: bigint, decimals: number): string {
  const unit = 10n ** BigInt(Math.max(0, decimals));
  const whole = value / unit;
  const fraction = value % unit;
  if (decimals <= 0 || fraction === 0n) return whole.toString();
  const fractionText = fraction
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${whole.toString()}.${fractionText}`;
}

function formatSignedRaw(value: bigint, decimals: number): string {
  const sign = value > 0n ? "+" : value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  return `${sign}${formatRawLocal(abs, decimals)}`;
}
function formatDurationMs(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0ms";
  if (value < 1_000) return `${value.toFixed(value < 10 ? 1 : 0)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(2)}s`;
  return `${(value / 60_000).toFixed(2)}m`;
}

function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return value >= 0.001
    ? value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "")
    : value.toExponential(6);
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
function targetWallets(
  slrd: { groupWallets(name: string): unknown[] },
  flags: Flags,
  usage: string,
): { mode: "wallet" | "wallets" | "group"; refs: string[]; group?: string } {
  const wallet = flags.get("wallet");
  const wallets = csv(flags.get("wallets"));
  const group = flags.get("group");
  const selected = [Boolean(wallet), wallets.length > 0, Boolean(group)].filter(
    Boolean,
  ).length;
  if (selected !== 1)
    throw new Error(
      `${usage} Supply exactly one of --wallet, --wallets, or --group.`,
    );
  if (wallet) return { mode: "wallet", refs: [wallet] };
  if (wallets.length > 0) return { mode: "wallets", refs: wallets };
  return {
    mode: "group",
    refs: slrd.groupWallets(group!).map((ref) => String(ref)),
    group,
  };
}
function commandNeedsSigningVault(
  command: string | undefined,
  values: string[],
  flags: Flags,
): boolean {
  if (!command) return false;
  if (command === "wallet" && values[0] === "create") return true;
  if (
    [
      "import",
      "export",
      "transfer",
      "send-sol",
      "buy",
      "sell",
      "unwrap-wsol",
      "claim",
    ].includes(command)
  )
    return true;
  if (command === "alt" && (values[0] === "create" || values[0] === "extend"))
    return true;
  if (command === "vanity" && values[0] === "pool" && values[1] === "generate")
    return true;
  if (
    flags.has("live") &&
    [
      "swap",
      "sweep",
      "liquidate",
      "meteora",
      "raydium",
      "launch",
      "deploy",
      "vamp",
      "spam-buy",
      "buy-spam",
      "run",
    ].includes(command)
  )
    return true;
  return false;
}

async function storedWalletCount(): Promise<number> {
  const { createTraderSolard } = await import("@solard/sdk");
  const probe = createTraderSolard();
  try {
    return probe.wallets.list().length;
  } finally {
    probe.close();
  }
}

function help(): string {
  return `${OWL} slrd — multi-wallet Solana CLI + SDK for traders and AI agents

Wallets and tokens
  slrd setup [--status] [--adopt-env]        First-time local vault setup / migrate an existing SLRD_MASTER_KEY
  slrd wallet create [name]                  Generate and persist an encrypted Solana wallet
  slrd import <private_key> [name]
  cat key.json | slrd import --stdin [name]

External contacts (public addresses only; never signing wallets or group members)
  slrd contact add <name> <address> [--force]
  slrd contact list
  slrd contact show <name|address>
  slrd contact remove <name|address>
  slrd wallets [--wallet <wallet>] [--group <name>] [--token <token> | --tokens] [--token-totals] [--only-with-tokens] [--rpc-concurrency <n>] [--rpc-delay-ms <n>] [--addresses-only]
                                                        Show SOL by default; token scans are opt-in
  slrd balances --wallet <wallet> [--token <token>] [--show-zero]        Show SOL + all SPL token balances for one wallet
  slrd fees --wallet <wallet> [--since 30m] [--limit 100]               Sum actual on-chain transaction fees paid by this wallet
  slrd sol-flow --wallet <wallet> [--since 30m] [--limit 100]            Audit native SOL + WSOL + SPL deltas from actual transactions
  slrd token <token_ca> [name] [--metadata-json <json>]
  slrd token set <token|ca> [--pool <address>] [--quote-mint <mint>] [--quote-program <program>] [--metadata-json <json>]
  slrd token refresh <token|ca>
  slrd token backfill <ca> [--replace] [--confirmed] [--batch-size 100] [--rpc-concurrency 3] [--max-signatures N] [--json]
                                                        Durable exact trades + sparse 1s candle materialization from creation
  slrd token trades <ca> [--from-start] [--min-sol N] [--owner <wallet>] [--side buy|sell] [--limit N] [--json]
  slrd token analyze <ca> [--top N] [--json]
  slrd tokens

Vanity mints
  slrd vanity --suffix pump --out .\\mint.json [--count <n>]
  slrd vanity pool generate --suffix pump --count <n> [--max-attempts <n>]   Generate encrypted mint keypairs into the canonical DB
  slrd vanity pool list [--suffix pump] [--status available|reserved|used]
  slrd vanity pool release <mint-address>               Release an ambiguous/failed launch reservation
  launch/vamp: add --mint-pool pump [--mint-pool-address <address>] to consume a pooled mint

Metadata and launching
  slrd launch pump --creator <wallet> (--uri <metadata_uri> | --metadata <json> | --image <path> --description <text>) [--alias <name>] [--live] [--skip-simulation]
                    [--deployment-sender helius-rpc|helius-fast] [--helius-tip-sol 0.01]
  slrd metadata upload --image <local_path> --name <name> --symbol <symbol> --description <text> [--provider pump-frontend|pinata]
                       [--twitter <url>] [--telegram <url>] [--website <url>] [--video <url>] [--hide-name]
  slrd vamp <source-mint> --creator <wallet> [--name <name>] [--symbol <symbol>] [--image <path-or-url>] [--description <text>]
                     [--website <url>] [--twitter <url>] [--telegram <url>] [--video <url>] [--uri <metadata-uri>]
                     [--buy-plan <file>] [--mint-pool pump] [--submit-mode jito-bundle] [--live] [--skip-simulation]
  slrd deploy pump --wallet <wallet> --name <name> --symbol <symbol> (--uri <metadata_uri> | --image <local_path> --description <text>) [--alias <name>] [--live]
                   [--twitter <url>] [--telegram <url>] [--website <url>] [--video <url>] [--hide-name]

Prices
  slrd quote buy <token|ca> --sol <amount>           Inspect buy quote without submitting
  slrd price <token|ca>                              Sample current venue price
  slrd price average <token|ca> --period 15m         Average stored samples in a period
  slrd price watch <token|ca...> [--interval 1s] [--period 1m]

Backtesting
  slrd backtest <mint> --dip-pct 20 --profit-pct 40 --buy-sol 0.1 [--from creation|migration|<time>] [--to <time>] [--capital-sol 5] [--slippage-bps N] [--venue-fee-bps N] [--network-fee-sol N] [--latency-ms N] [--require-from-start] [--exact-trades] [--ledger[=<csv>]] [--json]
                                                        Replays sparse 1s candles by default; --exact-trades uses durable market fills

Transfers and consolidation
  slrd transfer <contact|wallet|address> --wallet <source-wallet> --sol <amount> [--simulate-only]
  slrd transfer <contact|wallet|address> --wallet <source-wallet> --token <USDC|mint> --amount <ui> [--simulate-only]
  slrd sweep sol --to <contact|wallet|address> [--wallets <a,b,...>] [--max-balance-sol <SOL>] [--exclude-group <group>] [--exclude-prefix <prefix>] [--keep <wallet=SOL,...>] [--keep-if-tokens <SOL> | --keep-if-token <token>=<SOL>] [--simulate | --live] [--json]
                                                        Without --wallets, sweep considers all stored signing wallets

Token liquidation
  slrd liquidate tokens --except <token|mint> [--wallets <a,b,...>] [--slippage-bps 1500] [--no-jupiter] [--burn-unsellable] [--simulate | --live]
                                                        Sell supported tokens except protected mint(s); unwrap WSOL; close unprotected zero-balance token accounts and reclaim rent

RPC
  All Solard JSON-RPC traffic is globally rate-limited to 5 req/s by default.
  Override only when your provider allows it: SLRD_RPC_MAX_RPS=<n>
  Fetch-level network failures (ECONNRESET, socket close, etc.) retry 4 times by default; SLRD_RPC_NETWORK_RETRIES=<n>.
  Jupiter fallback: keyless 0.5 req/s, API-key default 1 req/s; override SLRD_JUPITER_MAX_RPS=<n>

Diagnostics
  Commands collect measure-fn telemetry without streaming it to the terminal.
  --measure         Print top aggregate timings after the normal command result
  --measure-stream  Restore raw live measure-fn output for low-level debugging

Trading
  slrd swap --from <SOL|token|mint> --to <SOL|token|mint> --amount <ui> --wallet <wallet> [--live]  Jupiter exact-input any -> any; quote-only unless --live
  slrd swap <token|mint> --wallet <wallet> --sol <amount> [--live]                              Compatibility: SOL -> token
  slrd buy <token|ca> (--wallet <wallet> | --wallets <w1,w2> | --group <name>) --sol <amount> [--venue auto|native|jupiter] [--slippage-bps 1500] [--sender rpc|helius|jito] [--simulate-only]
  slrd buy <future-mint> (--wallet <wallet> | --group <name>) (--sol <amount> | --lamports <amount> | --min-bps <n> --max-bps <n>) --spam [--live]
  slrd spam-buy [pump] <future-mint> (--wallet <wallet> | --group <name>) (--sol <amount> | --lamports <amount> | --min-bps <n> --max-bps <n>) [--sender <id>] [--live]
  slrd sell <token|ca> (--wallet <wallet> | --wallets <w1,w2> | --group <name>) [--bps 10000] [--venue auto|native|jupiter] [--slippage-bps 1500] [--sender rpc|helius|jito] [--simulate-only]
  slrd unwrap-wsol (--wallet <wallet> | --wallets <w1,w2> | --group <name>) [--sender rpc|helius|jito] [--ignore-missing] [--continue-on-error] [--simulate-only]
  slrd claim <token|ca> --wallet <wallet> [--sender rpc|helius|jito]

Scripts (strategies stay outside the kernel)
  slrd scripts                              List scripts registered in slrd.config.ts
  slrd run <name-or-path> [script flags...] Execute a script that imports slrd
  slrd run snipe --name <exact_name> --group <group> --sol 0.05 --sender jito

Meteora DLMM
  slrd meteora discover --timeframe 30m --sort fee-active-tvl --limit 20
  slrd meteora opportunities --timeframe 30m --sort flow-inactive --min-inactive-pct 70 --limit 20
  slrd meteora token-pools <mint|symbol> --timeframe 30m
  slrd meteora pools --timeframe 30m --sort fee-tvl --limit 20
  slrd meteora pool <pool> [--timeframe 30m]
  slrd meteora candles <pool> [--timeframe 5m]
  slrd meteora positions --wallet <wallet|address>
  slrd meteora open <pool> --wallet <wallet> --sol 0.1 --bins 40 [--strategy spot] [--live]
  slrd meteora move <position> --wallet <wallet> [--bins 10] [--live]
  slrd meteora migrate <position> --wallet <wallet> --to-pool <pool> [--bins 10] [--live]
  slrd meteora add|remove|claim|close <position> --wallet <wallet> [--live]
  slrd meteora close-all <pool> --wallet <wallet> [--live]
  slrd meteora quote <pool> (--in-x N|--in-y N|--out-x N|--out-y N)
  slrd meteora swap <pool> --wallet <wallet> (--in-x N|--in-y N|--out-x N|--out-y N) [--live]
  slrd meteora help                              Full Meteora command reference

Groups and agents
  slrd group create <name> [description]
  slrd group add <group> <wallet> [weight_bps]
  slrd group add-many <group> <wallet1,wallet2,...>
  slrd group show <group>
  slrd group list
  slrd buy <token|ca> --group <name> --sol <amount> --sender jito      Submit group buys as Jito bundles, five tx per bundle
  slrd sell <token|ca> --group <name> --sender jito              Submit group sells as Jito bundles, five tx per bundle
  slrd agent create <name> --wallet <wallet> [--config-json <json>]
  slrd agent list

Watching
  slrd watch token <token|ca> [label]
  slrd watch wallet <wallet> [label]
  slrd watch program <address> [label]
  slrd watch list

Transactions and ALTs
  slrd history
  slrd jito tip-accounts [--endpoint <block-engine-url>]
  slrd alt add <address> [label]
  slrd alt list
  slrd alt create --wallet <wallet>
  slrd alt extend <address> --wallet <wallet> <account...>

Environment
  SLRD_DB_PATH      shared SDK/CLI database; default ./slrd.db (SOLARD_DB_PATH alias supported)
  SLRD_MASTER_KEY   optional explicit override for CI/automation; interactive CLI uses the local vault
  RPC_ENDPOINT      required only for chain operations
  HELIUS_SENDER_URL regional/global Helius Sender endpoint used by launch scripts
  HELIUS_RPC_URL    RPC endpoint used for ordinary Helius-RPC buyer lane
  HELIUS_TIP_ACCOUNT, HELIUS_TIP_LAMPORTS, HELIUS_PRIORITY_MICRO_LAMPORTS launch transport policy
  SLRD_LAUNCH_*     launch resend/timeout policy; shared environment, not per-token metadata
  JITO_BLOCK_ENGINE_URL only when explicitly selecting the separate Jito sender
  SLRD_METADATA_UPLOADER metadata provider; default pump-frontend; optional pinata
  PUMP_IPFS_ENDPOINT browser-facing Pump metadata upload endpoint; default https://pump.fun/api/ipfs
  PINATA_JWT       required only with --provider pinata or explicit pinata fallback
  IPFS_PUBLIC_GATEWAY optional Pinata returned metadata gateway; default https://ipfs.io/ipfs
`;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, flags } = args(rest);

  const commandStartedAt = performance.now();
  const measureCollector = createSolardMeasureCollector();
  resetSolardRpcStats();

  // Keep measurement active, but route events away from terminal output.
  // --measure adds a detailed aggregate at the end; --measure-stream restores
  // measure-fn's raw live logger for low-level debugging.
  const streamMeasures =
    flags.has("measure-stream") ||
    process.env.SLRD_MEASURE_STREAM === "1" ||
    process.env.SLRD_MEASURE_STREAM === "true";
  configureSolardMeasure(
    streamMeasures
      ? {
          silent: false,
          // Middleware mode: accumulate the structured event and then delegate
          // to measure-fn's built-in logger. The collector itself does not own
          // formatting or streaming.
          logger: measureCollector.middleware,
        }
      : {
          silent: false,
          // Replacement mode: accumulate without printing every span.
          logger: measureCollector.logger,
        },
  );

  const vaultCommand = command === "setup";
  const needsVault = commandNeedsSigningVault(command, values, flags);
  if (vaultCommand || needsVault) {
    // Environment overrides always win; otherwise use the remembered Windows
    // credential when available. This runs before launch/run subcommands so
    // child scripts inherit SLRD_MASTER_KEY without needing a second prompt.
    loadRememberedCliVault();

    if (vaultCommand && flags.has("status")) {
      const status = cliVaultStatus();
      if (flags.has("json")) {
        emit(json(status) + "\n");
      } else {
        emit(
          `${OWL} vault\n` +
            `  configured   ${status.configured ? "yes" : "no"}\n` +
            `  remembered   ${status.remembered ? "yes" : "no"}\n` +
            `  env override ${status.environmentOverride ? "yes" : "no"}\n` +
            `  profile      ${status.path}\n`,
        );
      }
      return;
    }

    if (vaultCommand || !process.env.SLRD_MASTER_KEY?.trim()) {
      const result = await ensureCliVaultReady({
        existingWalletCount: await storedWalletCount(),
        allowCreate: true,
        adoptEnvironment: vaultCommand && flags.has("adopt-env"),
      });
      if (vaultCommand) {
        emit(
          `${OWL} vault ready  source=${result.source}  ` +
            `remembered=${result.remembered ? "yes" : "no"}\n` +
            `   ${result.path}\n`,
        );
        if (result.source === "env" && !result.created) {
          emit(
            `   Tip: run \`slrd setup --adopt-env\` to persist the current environment key safely.\n`,
          );
        }
        return;
      }
    }
  }

  let perfPrinted = false;
  const printPerfSummary = () => {
    if (perfPrinted) return;
    perfPrinted = true;

    const measures = measureCollector.snapshot();
    const rpc = getSolardRpcStats();
    const wallMs = Math.max(0, performance.now() - commandStartedAt);

    if (
      measures.completed === 0 &&
      measures.annotations === 0 &&
      rpc.requestStarts === 0
    ) {
      return;
    }

    emit(
      `PERF     wall=${formatDurationMs(wallMs)}  ` +
        `measure=${measures.completed} (${measures.errors} err)  ` +
        `rpc=${rpc.requestStarts}  429=${rpc.rateLimited429}  ` +
        `neterr=${rpc.networkErrors}  ` +
        `retries=${rpc.retries429 + rpc.retriesNetwork} ` +
        `(429=${rpc.retries429},net=${rpc.retriesNetwork})  ` +
        `limit=${rpc.maxRps}/s\n`,
    );

    if (flags.has("measure") && !streamMeasures) {
      for (const row of measures.labels.slice(0, 10)) {
        emit(
          `  ${row.label}  calls=${row.calls}  ` +
            `total=${formatDurationMs(row.totalMs)}  ` +
            `max=${formatDurationMs(row.maxMs)}` +
            `${row.errors ? `  errors=${row.errors}` : ""}\n`,
        );
      }
    }
  };

  process.once("beforeExit", printPerfSummary);

  if (!command || command === "help" || command === "--help") {
    emit(help());
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { name: string; version: string };
    emit(`${OWL} ${pkg.name} ${pkg.version} (bun ${Bun.version})\n`);
    return;
  }
  if (command === "vanity") {
    const {
      addVanityMintToPool,
      cleanVanitySuffix,
      defaultVanityMaxAttempts,
      generateMintKeypairWithSuffix,
      listVanityMintPool,
      releaseVanityMintReservation,
      saveMintKeypairFile,
    } = await import("@solard/sdk");

    if (values[0] === "pool") {
      const action = values[1] ?? "list";

      if (action === "generate") {
        const suffix = cleanVanitySuffix(need(flags, "suffix"));
        const count = int(flags, "count", 1)!;
        if (count <= 0) throw new Error("--count must be greater than zero");
        const results = [];
        for (let i = 0; i < count; i++) {
          const found = await generateMintKeypairWithSuffix({
            suffix,
            workers: int(flags, "workers"),
            maxAttempts: int(
              flags,
              "max-attempts",
              defaultVanityMaxAttempts(suffix),
            )!,
            timeoutMs: int(flags, "timeout-ms", 0)!,
            reportEvery: int(flags, "report-every", 1_000_000)!,
            onProgress: (p) =>
              emit(
                `${OWL} pool grinding ${p.suffix} [${i + 1}/${count}]: ${p.attempts} attempts, ${p.ratePerSecond}/s\n`,
              ),
          });
          results.push({
            ...addVanityMintToPool(found.mint, suffix),
            attempts: found.attempts,
            elapsedMs: found.elapsedMs,
          });
        }
        emit(json(results) + "\n");
        return;
      }

      if (action === "list") {
        const status = flags.get("status") as
          "available" | "reserved" | "used" | undefined;
        if (
          status &&
          status !== "available" &&
          status !== "reserved" &&
          status !== "used"
        ) {
          throw new Error("--status must be available, reserved, or used");
        }
        emit(
          json(
            listVanityMintPool({
              suffix: flags.get("suffix"),
              status,
            }),
          ) + "\n",
        );
        return;
      }

      if (action === "release") {
        const address = values[2] ?? flags.get("address");
        if (!address)
          throw new Error("Usage: slrd vanity pool release <mint-address>");
        emit(json(releaseVanityMintReservation(address)) + "\n");
        return;
      }

      throw new Error(
        "Usage: slrd vanity pool <generate|list|release> [options]",
      );
    }

    const suffix = cleanVanitySuffix(need(flags, "suffix"));
    const out = need(flags, "out");
    const count = int(flags, "count", 1)!;
    const results = [];
    for (let i = 0; i < count; i++) {
      const found = await generateMintKeypairWithSuffix({
        suffix,
        workers: int(flags, "workers"),
        maxAttempts: int(
          flags,
          "max-attempts",
          defaultVanityMaxAttempts(suffix),
        )!,
        timeoutMs: int(flags, "timeout-ms", 0)!,
        reportEvery: int(flags, "report-every", 1_000_000)!,
        onProgress: (p) =>
          emit(
            `${OWL} grinding ${p.suffix}: ${p.attempts} attempts, ${p.ratePerSecond}/s\n`,
          ),
      });
      const path = count === 1 ? out : out.replace(/(\.json)?$/, `-${i + 1}$1`);
      const saved = saveMintKeypairFile(path, found.mint, {
        force: flags.has("force"),
      });
      results.push({
        address: found.mint.publicKey.toBase58(),
        keypairPath: saved,
        attempts: found.attempts,
        elapsedMs: found.elapsedMs,
        launchArguments: ["--mint-keypair", saved, "--mint-suffix", suffix],
      });
    }
    emit(json(count === 1 ? results[0] : results) + "\n");
    return;
  }
  if (command === "spam-buy" || command === "buy-spam") {
    const { runPumpSpamBuyFromArgs } = await import("./pump/spam-buy-cli.ts");
    await runPumpSpamBuyFromArgs(rest);
    return;
  }
  if (command === "buy" && flags.has("spam")) {
    const { runPumpSpamBuyFromArgs } = await import("./pump/spam-buy-cli.ts");
    await runPumpSpamBuyFromArgs(rest);
    return;
  }
  if (command === "backtest") {
    const { runBacktestCommand } = await import("./backtest-command.ts");
    await runBacktestCommand({ values, flags, emit });
    return;
  }
  if (command === "scripts") {
    emit(json(await listScripts()) + "\n");
    return;
  }
  if (command === "run") {
    const [script, ...scriptArgs] = rest;
    if (!script)
      throw new Error("Usage: slrd run <name-or-path> [script flags...]");
    process.exitCode = await runScript(script, scriptArgs);
    return;
  }
  if (
    command === "launch" &&
    (values[0] === "pump" || values[0] === "pump-token")
  ) {
    const { runPumpTokenLaunchFromArgs } =
      await import("./pump/token-launch-cli.ts");
    await runPumpTokenLaunchFromArgs(rest.slice(1), {
      defaultSubmitMode: "after-deploy-processed",
      defaultDeploymentPriorityMicroLamports: 500_000,
      defaultBuyerPriorityMicroLamports: 1_500_000,
      defaultSlippageBps: 1_500,
      persistOnLive: true,
      report: (label, value) => emit(`${label}: ${json(value)}\n`),
    });
    return;
  }
  if (command === "vamp") {
    const { runPumpVampFromArgs } = await import("./pump/vamp-cli.ts");
    await runPumpVampFromArgs(rest, {
      defaultSubmitMode: "after-deploy-processed",
      defaultDeploymentPriorityMicroLamports: 500_000,
      defaultBuyerPriorityMicroLamports: 1_500_000,
      defaultSlippageBps: 1_500,
      persistOnLive: true,
      report: (label, value) => emit(`${label}: ${json(value)}\n`),
    });
    return;
  }
  if (command === "jito" && values[0] === "tip-accounts") {
    const endpoint = (
      flags.get("endpoint") ??
      process.env.JITO_BLOCK_ENGINE_URL ??
      "https://mainnet.block-engine.jito.wtf"
    ).replace(/\/$/, "");
    const { getJitoTipAccounts } = await import("@solard/sdk");
    const tipAccounts = await getJitoTipAccounts(endpoint);
    emit(json({ endpoint, tipAccounts }) + "\n");
    return;
  }
  if (command === "metadata" && values[0] === "upload") {
    const { uploadPumpMetadata } = await import("@solard/sdk");
    const uploaded = await uploadPumpMetadata(
      {
        imagePath: need(flags, "image"),
        name: need(flags, "name"),
        symbol: need(flags, "symbol"),
        description: need(flags, "description"),
        twitter: flags.get("twitter"),
        telegram: flags.get("telegram"),
        website: flags.get("website"),
        video: flags.get("video"),
        showName: !flags.has("hide-name"),
      },
      {
        provider: (flags.get("provider") ??
          process.env.SLRD_METADATA_UPLOADER ??
          "pump-frontend") as "pump-frontend" | "pinata",
        endpoint: flags.get("endpoint"),
        fallback: flags.get("fallback") === "pinata" ? "pinata" : null,
      },
    );
    emit(json(uploaded) + "\n");
    return;
  }
  const [{ sol, formatRaw }, { shortKey }, { createTraderSolard }] =
    await Promise.all([
      import("@solard/sdk"),
      import("@solard/sdk"),
      import("@solard/sdk"),
    ]);
  const slrd = createTraderSolard();
  try {
    if (command === "meteora") {
      await handleMeteoraCommand({ slrd, values, flags, emit });
      return;
    }

    if (command === "swap") {
      const { runJupiterSwapCommand } =
        await import("./commands/jupiter-swap.ts");
      emit(json(await runJupiterSwapCommand({ slrd, values, flags })) + "\n");
      return;
    }
    if (command === "contact" || command === "contacts") {
      const action = values[0] ?? "list";

      if (action === "add") {
        const name = values[1];
        const address = values[2];
        if (!name || !address) {
          throw new Error("Usage: slrd contact add <name> <address> [--force]");
        }

        let walletCollision: string | null = null;
        try {
          walletCollision = slrd.resolveWallet(name).address.toBase58();
        } catch {
          walletCollision = null;
        }
        if (walletCollision && walletCollision !== address) {
          throw new Error(
            `Cannot create external contact @${name}: a stored signing wallet already uses that name (${walletCollision}).`,
          );
        }

        const contact = addExternalContact(name, address, {
          overwrite: flags.has("force") || flags.has("overwrite"),
        });
        emit(`${OWL} contact @${contact.name}\t${contact.address}\n`);
        return;
      }

      if (action === "list") {
        const contacts = listExternalContacts();
        if (flags.has("json")) {
          emit(json(contacts) + "\n");
          return;
        }
        for (const contact of contacts) {
          emit(`@${contact.name}\t${contact.address}\n`);
        }
        return;
      }

      if (action === "show") {
        const ref = values[1];
        if (!ref) throw new Error("Usage: slrd contact show <name|address>");
        const contact = findExternalContact(ref);
        if (!contact) throw new Error(`Unknown external contact: ${ref}`);
        emit(json(contact) + "\n");
        return;
      }

      if (action === "remove" || action === "delete" || action === "rm") {
        const ref = values[1];
        if (!ref) throw new Error("Usage: slrd contact remove <name|address>");
        const removed = removeExternalContact(ref);
        emit(`${OWL} removed contact @${removed.name}\t${removed.address}\n`);
        return;
      }

      throw new Error("Usage: slrd contact <add|list|show|remove> [arguments]");
    }

    if (command === "wallet" && values[0] === "create") {
      const firstWallet = slrd.wallets.list().length === 0;
      const wallet = slrd.createWallet(
        values[1] ?? (firstWallet ? "main" : undefined),
      );
      if (flags.has("json")) {
        emit(json(wallet) + "\n");
      } else if (process.stdout.isTTY) {
        emit(
          `\n╭─ ${OWL} wallet ready ──────────────────────────────────╮\n` +
            `  name     @${wallet.name}\n` +
            `  address  ${wallet.address}\n` +
            `  storage  encrypted in your local Solard vault\n` +
            `╰──────────────────────────────────────────────────────╯\n` +
            `\nNext:  slrd balances --wallet ${wallet.name}\n` +
            `Backup: slrd export ${wallet.name} --out .\\${wallet.name}-key.txt\n`,
        );
      } else {
        emit(`${OWL} created @${wallet.name} ${wallet.address}\n`);
      }
      return;
    }
    if (command === "export") {
      const ref = values[0];
      if (!ref)
        throw new Error(
          "Usage: slrd export <wallet|address> [--json] [--out <path>]",
        );
      const bs58 = (await import("bs58")).default;
      const { signer, row } = slrd.wallets.signer(ref);
      const secret = flags.has("json")
        ? JSON.stringify(Array.from(signer.secretKey))
        : bs58.encode(signer.secretKey);

      const out = flags.get("out");
      if (out && out !== "true") {
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { dirname, resolve } = await import("node:path");
        const path = resolve(out);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${secret}\n`, { mode: 0o600, flag: "wx" });
        emit(
          `${OWL} exported @${row?.name ?? "?"} ${signer.publicKey.toBase58()} -> ${path}\n`,
        );
        return;
      }

      // Secret to stdout only; metadata to stderr so piping stays clean.
      process.stderr.write(
        `${OWL} @${row?.name ?? "?"} ${signer.publicKey.toBase58()} (${flags.has("json") ? "keypair-json" : "base58"})\n`,
      );
      process.stdout.write(`${secret}\n`);
      return;
    }
    if (command === "import") {
      const input = flags.has("stdin")
        ? (await new Response(Bun.stdin.stream()).text()).trim()
        : values[0];
      if (!input)
        throw new Error(
          "Usage: slrd import <private_key> [name] [--force] or cat key.json | slrd import --stdin [name] [--force]",
        );
      const name = flags.has("stdin") ? values[0] : values[1];
      const wallet = slrd.importWallet(input, name, {
        overwrite: flags.has("force") || flags.has("overwrite"),
      });
      emit(`${OWL} imported @${wallet.name} ${wallet.address}\n`);
      return;
    }
    if (command === "wallets" || command === "balances") {
      if (
        flags.get("token") &&
        (flags.has("tokens") || flags.has("all-tokens"))
      ) {
        throw new Error("Use either --token <token> or --tokens, not both.");
      }

      let wallets = slrd.wallets.list();
      const singleWalletRef =
        flags.get("wallet") ?? (command === "balances" ? values[0] : undefined);
      if (singleWalletRef) {
        const wanted = slrd.resolveWallet(singleWalletRef).address.toBase58();
        wallets = wallets.filter(
          (wallet) => slrd.resolveWallet(wallet).address.toBase58() === wanted,
        );
        if (wallets.length === 0)
          throw new Error(`Wallet ${singleWalletRef} is not a stored wallet`);
      }
      if (command === "balances" && !singleWalletRef)
        throw new Error("Usage: slrd balances --wallet <wallet>");
      const group = flags.get("group");
      if (group) {
        const addresses = new Set(
          slrd
            .groupWallets(group)
            .map((ref) => slrd.resolveWallet(ref).address.toBase58()),
        );
        wallets = wallets.filter((wallet) => addresses.has(wallet.address));
      }

      if (flags.has("addresses-only")) {
        for (const wallet of wallets)
          emit(`@${wallet.name}\t${wallet.address}\n`);
        return;
      }

      const allTokens =
        command === "balances" ||
        flags.has("tokens") ||
        flags.has("all-tokens");
      const tokenRef = flags.get("token");
      if (!allTokens && !tokenRef) {
        // Cheap native-SOL-only default: <=100 wallets per RPC call.
        const rows: Array<{
          wallet: (typeof wallets)[number];
          solLamports: bigint;
        }> = [];
        const connection = slrd.connection();
        const batchSize = 100;

        for (let offset = 0; offset < wallets.length; offset += batchSize) {
          const batch = wallets.slice(offset, offset + batchSize);
          const addresses = batch.map(
            (wallet) => slrd.resolveWallet(wallet).address,
          );
          const accounts = await connection.getMultipleAccountsInfo(
            addresses,
            "confirmed",
          );

          for (let index = 0; index < batch.length; index += 1) {
            rows.push({
              wallet: batch[index]!,
              solLamports: BigInt(accounts[index]?.lamports ?? 0),
            });
          }
        }

        rows.sort((left, right) =>
          left.solLamports === right.solLamports
            ? left.wallet.name.localeCompare(right.wallet.name)
            : left.solLamports > right.solLamports
              ? -1
              : 1,
        );

        const totalSol = rows.reduce((sum, row) => sum + row.solLamports, 0n);
        emit(`TOTAL\tSOL=${formatRaw(totalSol, 9)}\tWALLETS=${rows.length}\n`);
        for (const { wallet, solLamports } of rows) {
          emit(
            `@${wallet.name}\t${wallet.address}\tSOL=${formatRaw(solLamports, 9)}\n`,
          );
        }
        return;
      }

      // Owner-centric token discovery. This never refreshes/upserts the token
      // registry, so `wallets --tokens` stays read-only and its stdout remains
      // actual portfolio output instead of measurement noise.
      const portfolio = await loadWalletAssetPortfolio(slrd, {
        walletRefs: wallets.map((wallet) => wallet.address),
        includeZero: flags.has("show-zero"),
        concurrency: Math.max(
          1,
          Math.min(8, Math.trunc(int(flags, "rpc-concurrency", 1) ?? 1)),
        ),
        requestDelayMs: Math.max(
          0,
          Math.trunc(int(flags, "rpc-delay-ms", 75) ?? 75),
        ),
      });

      const selectedMint = tokenRef ? slrd.resolveToken(tokenRef).mint : null;

      const visibleRows = portfolio.rows.map((row) => ({
        ...row,
        tokenHoldings: selectedMint
          ? row.tokenHoldings.filter((holding) => holding.mint === selectedMint)
          : row.tokenHoldings,
      }));

      const visibleTotals = new Map<
        string,
        {
          mint: string;
          name: string | null;
          symbol: string | null;
          decimals: number;
          amountRaw: bigint;
        }
      >();
      for (const row of visibleRows) {
        for (const holding of row.tokenHoldings) {
          if (holding.amountRaw <= 0n && !flags.has("show-zero")) continue;
          const existing = visibleTotals.get(holding.mint);
          if (existing) existing.amountRaw += holding.amountRaw;
          else
            visibleTotals.set(holding.mint, {
              mint: holding.mint,
              name: holding.name,
              symbol: holding.symbol,
              decimals: holding.decimals,
              amountRaw: holding.amountRaw,
            });
        }
      }

      const holdingCount = visibleRows.reduce(
        (sum, row) =>
          sum +
          row.tokenHoldings.filter(
            (holding) => holding.amountRaw > 0n || flags.has("show-zero"),
          ).length,
        0,
      );

      emit(
        `PORTFOLIO  ${visibleRows.length} wallets | ` +
          `${formatRaw(portfolio.totalSolLamports, 9)} SOL | ` +
          `${holdingCount} token holdings | ${visibleTotals.size} mints` +
          `${portfolio.tokenScanErrorCount ? ` | ${portfolio.tokenScanErrorCount} scan errors` : ""}\n`,
      );

      if (flags.has("token-totals")) {
        const aggregateRows = [...visibleTotals.values()].sort((left, right) =>
          (left.symbol ?? left.name ?? left.mint).localeCompare(
            right.symbol ?? right.name ?? right.mint,
          ),
        );
        emit("\nTOKEN TOTALS\n");
        for (const total of aggregateRows) {
          const label = total.symbol
            ? total.symbol
            : (total.name ?? shortKey(total.mint));
          emit(
            `  ${label.padEnd(14)} ${formatRaw(total.amountRaw, total.decimals).padStart(18)}  ${total.mint}\n`,
          );
        }
      }

      for (const row of visibleRows) {
        const holdings = row.tokenHoldings.filter(
          (holding) =>
            holding.amountRaw > 0n ||
            flags.has("show-zero") ||
            Boolean(tokenRef),
        );
        if (
          flags.has("only-with-tokens") &&
          holdings.every((holding) => holding.amountRaw <= 0n)
        ) {
          continue;
        }

        emit(
          `\n@${row.walletName}  SOL ${formatRaw(row.solLamports, 9)}  ` +
            `${holdings.filter((holding) => holding.amountRaw > 0n).length} token(s)\n`,
        );
        emit(`  ${row.walletAddress}\n`);

        for (const holding of holdings) {
          const label = holding.symbol
            ? holding.symbol
            : (holding.name ?? shortKey(holding.mint));
          emit(
            `  ${label.padEnd(14)} ${holding.amountUi.padStart(18)}  ${holding.mint}\n`,
          );
        }

        if (!row.tokenScanComplete) {
          emit(
            `  ! token scan partial (${row.tokenScanErrors.length} error(s))\n`,
          );
          if (flags.has("verbose")) {
            for (const error of row.tokenScanErrors) {
              process.stderr.write(
                `${OWL} token scan @${row.walletName}: ${error}\n`,
              );
            }
          }
        }
      }
      return;
    }
    if (command === "fees" || (command === "tx" && values[0] === "fees")) {
      const walletRef = need(flags, "wallet");
      const wallet = slrd.resolveWallet(walletRef);
      const address = wallet.address;
      const addressText = address.toBase58();
      const limit = Math.max(
        1,
        Math.min(1_000, Math.trunc(int(flags, "limit", 100) ?? 100)),
      );
      const sinceMs = duration(flags.get("since"), 30 * 60_000);
      const cutoff = Date.now() - sinceMs;
      const connection = slrd.connection();
      const signatures = await connection.getSignaturesForAddress(
        address,
        { limit },
        "confirmed",
      );
      const recent = signatures.filter(
        (entry) => entry.blockTime == null || entry.blockTime * 1_000 >= cutoff,
      );
      let totalLamports = 0n;
      let feeMetaFound = 0;
      let paidByWalletCount = 0;
      let failed = 0;
      const rows: Array<{
        signature: string;
        blockTime: number | null | undefined;
        feeLamports: number | null;
        paidByWallet: boolean;
        err: unknown;
      }> = [];
      for (const entry of recent) {
        try {
          const tx = await connection.getTransaction(entry.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          const fee = tx?.meta?.fee;
          const payer = txAccountKeys(tx)[0] ?? "";
          const paidByWallet = payer === addressText;
          if (typeof fee === "number" && Number.isFinite(fee)) {
            feeMetaFound += 1;
            if (paidByWallet) {
              totalLamports += BigInt(Math.trunc(fee));
              paidByWalletCount += 1;
            }
            rows.push({
              signature: entry.signature,
              blockTime: entry.blockTime,
              feeLamports: Math.trunc(fee),
              paidByWallet,
              err: entry.err,
            });
          } else {
            rows.push({
              signature: entry.signature,
              blockTime: entry.blockTime,
              feeLamports: null,
              paidByWallet,
              err: entry.err,
            });
          }
        } catch {
          failed += 1;
          rows.push({
            signature: entry.signature,
            blockTime: entry.blockTime,
            feeLamports: null,
            paidByWallet: false,
            err: entry.err,
          });
        }
      }
      emit(
        `FEES  @${wallet.row?.name ?? walletRef}  ${addressText}\n` +
          `Window: ${flags.get("since") ?? "30m"}  transactions=${recent.length}  fee-meta=${feeMetaFound}  wallet-paid=${paidByWalletCount}  unavailable=${recent.length - feeMetaFound}\n` +
          `Actual network fees paid by wallet: ${(Number(totalLamports) / 1e9).toFixed(9)} SOL (${totalLamports.toString()} lamports)\n`,
      );
      if (!flags.has("summary-only")) {
        emit(
          "\nTIME                      FEE SOL       PAYER   STATUS   SIGNATURE\n",
        );
        for (const row of rows) {
          const time = row.blockTime
            ? new Date(row.blockTime * 1_000).toISOString()
            : "-";
          const feeSol =
            row.feeLamports == null ? "-" : (row.feeLamports / 1e9).toFixed(9);
          emit(
            `${time.padEnd(25)} ${feeSol.padStart(12)}  ${(row.paidByWallet ? "YOU" : "OTHER").padEnd(6)}  ${(row.err ? "FAILED" : "OK").padEnd(7)}  ${row.signature}\n`,
          );
        }
      }
      if (failed > 0)
        process.stderr.write(
          `${OWL} ${failed} transaction lookup(s) failed; rerun after RPC history catches up.\n`,
        );
      return;
    }
    if (command === "sol-flow" || (command === "tx" && values[0] === "flow")) {
      const walletRef = need(flags, "wallet");
      const wallet = slrd.resolveWallet(walletRef);
      const address = wallet.address;
      const addressText = address.toBase58();
      const limit = Math.max(
        1,
        Math.min(1_000, Math.trunc(int(flags, "limit", 100) ?? 100)),
      );
      const sinceMs = duration(flags.get("since"), 30 * 60_000);
      const cutoff = Date.now() - sinceMs;
      const connection = slrd.connection();
      const signatures = await connection.getSignaturesForAddress(
        address,
        { limit },
        "confirmed",
      );
      const recent = signatures.filter(
        (entry) => entry.blockTime == null || entry.blockTime * 1_000 >= cutoff,
      );

      type FlowRow = {
        signature: string;
        blockTime: number | null | undefined;
        err: unknown;
        nativeDeltaLamports: bigint | null;
        feeLamports: bigint;
        feePaidByWallet: boolean;
        wsolDeltaRaw: bigint;
        tokenDeltas: Array<{
          mint: string;
          decimals: number;
          deltaRaw: bigint;
        }>;
      };

      const rows: FlowRow[] = [];
      let nativeDeltaLamports = 0n;
      let nativeAvailable = 0;
      let walletFeeLamports = 0n;
      let wsolDeltaRaw = 0n;
      let failed = 0;
      const tokenTotals = new Map<
        string,
        { decimals: number; deltaRaw: bigint }
      >();

      for (const entry of recent) {
        try {
          const tx = await connection.getTransaction(entry.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          if (!tx?.meta) {
            rows.push({
              signature: entry.signature,
              blockTime: entry.blockTime,
              err: entry.err,
              nativeDeltaLamports: null,
              feeLamports: 0n,
              feePaidByWallet: false,
              wsolDeltaRaw: 0n,
              tokenDeltas: [],
            });
            continue;
          }

          const keys = txAccountKeys(tx);
          const walletIndex = keys.indexOf(addressText);
          let txNativeDelta: bigint | null = null;
          if (
            walletIndex >= 0 &&
            typeof tx.meta.preBalances?.[walletIndex] === "number" &&
            typeof tx.meta.postBalances?.[walletIndex] === "number"
          ) {
            txNativeDelta =
              BigInt(Math.trunc(tx.meta.postBalances[walletIndex]!)) -
              BigInt(Math.trunc(tx.meta.preBalances[walletIndex]!));
            nativeDeltaLamports += txNativeDelta;
            nativeAvailable += 1;
          }

          const fee =
            typeof tx.meta.fee === "number" && Number.isFinite(tx.meta.fee)
              ? BigInt(Math.trunc(tx.meta.fee))
              : 0n;
          const feePaidByWallet = keys[0] === addressText;
          if (feePaidByWallet) walletFeeLamports += fee;

          const balances = txWalletTokenBalances(tx, addressText);
          const tokenDeltas: Array<{
            mint: string;
            decimals: number;
            deltaRaw: bigint;
          }> = [];
          let txWsol = 0n;
          for (const [mint, balance] of balances.entries()) {
            const deltaRaw = balance.post - balance.pre;
            if (deltaRaw === 0n) continue;
            tokenDeltas.push({ mint, decimals: balance.decimals, deltaRaw });
            const total = tokenTotals.get(mint) ?? {
              decimals: balance.decimals,
              deltaRaw: 0n,
            };
            total.decimals = balance.decimals;
            total.deltaRaw += deltaRaw;
            tokenTotals.set(mint, total);
            if (mint === NATIVE_SOL_MINT) {
              txWsol += deltaRaw;
              wsolDeltaRaw += deltaRaw;
            }
          }

          rows.push({
            signature: entry.signature,
            blockTime: entry.blockTime,
            err: entry.err,
            nativeDeltaLamports: txNativeDelta,
            feeLamports: fee,
            feePaidByWallet,
            wsolDeltaRaw: txWsol,
            tokenDeltas,
          });
        } catch {
          failed += 1;
          rows.push({
            signature: entry.signature,
            blockTime: entry.blockTime,
            err: entry.err,
            nativeDeltaLamports: null,
            feeLamports: 0n,
            feePaidByWallet: false,
            wsolDeltaRaw: 0n,
            tokenDeltas: [],
          });
        }
      }

      const nonFeeNativeDelta = nativeDeltaLamports + walletFeeLamports;
      const nativePlusWsol = nativeDeltaLamports + wsolDeltaRaw;
      const tokenSummary = [...tokenTotals.entries()]
        .filter(([, value]) => value.deltaRaw !== 0n)
        .sort((left, right) => {
          const leftAbs =
            left[1].deltaRaw < 0n ? -left[1].deltaRaw : left[1].deltaRaw;
          const rightAbs =
            right[1].deltaRaw < 0n ? -right[1].deltaRaw : right[1].deltaRaw;
          return leftAbs === rightAbs
            ? left[0].localeCompare(right[0])
            : leftAbs > rightAbs
              ? -1
              : 1;
        });

      if (flags.has("json")) {
        emit(
          json({
            wallet: addressText,
            window: flags.get("since") ?? "30m",
            transactions: recent.length,
            nativeAvailable,
            nativeDeltaLamports,
            walletFeeLamports,
            nonFeeNativeDeltaLamports: nonFeeNativeDelta,
            wsolDeltaRaw,
            nativePlusWsolLamports: nativePlusWsol,
            tokenDeltas: tokenSummary.map(([mint, value]) => ({
              mint,
              ...value,
            })),
            rows,
            failedLookups: failed,
          }) + "\n",
        );
        return;
      }

      emit(
        `SOL FLOW  @${wallet.row?.name ?? walletRef}  ${addressText}\n` +
          `Window: ${flags.get("since") ?? "30m"}  transactions=${recent.length}  native-meta=${nativeAvailable}  unavailable=${recent.length - nativeAvailable}\n` +
          `Native SOL delta:               ${formatSignedRaw(nativeDeltaLamports, 9)} SOL\n` +
          `Network fees paid by wallet:    -${formatRaw(walletFeeLamports, 9)} SOL\n` +
          `Native delta excluding fees:    ${formatSignedRaw(nonFeeNativeDelta, 9)} SOL\n` +
          `WSOL token-account delta:       ${formatSignedRaw(wsolDeltaRaw, 9)} WSOL\n` +
          `Native + WSOL wallet delta:     ${formatSignedRaw(nativePlusWsol, 9)} SOL-like\n`,
      );

      if (tokenSummary.length > 0) {
        emit("\nNET SPL TOKEN DELTAS IN WALLET\n");
        for (const [mint, value] of tokenSummary) {
          const label =
            mint === NATIVE_SOL_MINT
              ? "WSOL"
              : mint === CANONICAL_USDC_MINT
                ? "USDC"
                : shortKey(mint);
          emit(
            `  ${label.padEnd(12)} ${formatSignedRaw(value.deltaRaw, value.decimals).padStart(20)}  ${mint}\n`,
          );
        }
      }

      if (!flags.has("summary-only")) {
        emit("\nPER TRANSACTION\n");
        emit(
          "TIME                      NATIVE Δ SOL   FEE SOL      WSOL Δ      TOKEN DELTAS                         STATUS   SIGNATURE\n",
        );
        for (const row of rows) {
          const time = row.blockTime
            ? new Date(row.blockTime * 1_000).toISOString()
            : "-";
          const native =
            row.nativeDeltaLamports == null
              ? "-"
              : formatSignedRaw(row.nativeDeltaLamports, 9);
          const fee = row.feePaidByWallet ? formatRaw(row.feeLamports, 9) : "0";
          const wsol = formatSignedRaw(row.wsolDeltaRaw, 9);
          const other =
            row.tokenDeltas
              .filter((delta) => delta.mint !== NATIVE_SOL_MINT)
              .slice(0, 2)
              .map(
                (delta) =>
                  `${shortKey(delta.mint)} ${formatSignedRaw(delta.deltaRaw, delta.decimals)}`,
              )
              .join(", ") || "-";
          emit(
            `${time.padEnd(25)} ${native.padStart(13)}  ${fee.padStart(10)}  ${wsol.padStart(11)}  ${other.padEnd(35)}  ${(row.err ? "FAILED" : "OK").padEnd(7)}  ${row.signature}\n`,
          );
        }
      }

      emit(
        "\nNative SOL delta is a cash-flow number, not P&L: LP deposits, SOL->token swaps, account rent, and WSOL wrapping can all reduce it without being network fees.\n" +
          "Use the per-transaction rows to find the large negative native-SOL transactions; their token deltas show what the wallet received or deployed.\n",
      );
      if (failed > 0)
        process.stderr.write(
          `${OWL} ${failed} transaction lookup(s) failed; rerun after RPC history catches up.\n`,
        );
      return;
    }
    if (command === "deploy") {
      const launchpad = values[0] ?? "pump";
      const wallet = need(flags, "wallet");
      const name = need(flags, "name");
      const symbol = need(flags, "symbol");
      let uri = flags.get("uri");
      let uploadedMetadata: unknown = null;
      if (!uri || uri === "true") {
        if (!flags.get("image"))
          throw new Error(
            "Provide --uri <metadata_uri> or --image <local_path> --description <text>",
          );
        const { uploadPumpMetadata } = await import("@solard/sdk");
        uploadedMetadata = await uploadPumpMetadata(
          {
            imagePath: need(flags, "image"),
            name,
            symbol,
            description: need(flags, "description"),
            twitter: flags.get("twitter"),
            telegram: flags.get("telegram"),
            website: flags.get("website"),
            video: flags.get("video"),
            showName: !flags.has("hide-name"),
          },
          {
            provider: (flags.get("provider") ??
              process.env.SLRD_METADATA_UPLOADER ??
              "pump-frontend") as "pump-frontend" | "pinata",
            endpoint: flags.get("endpoint"),
            fallback: flags.get("fallback") === "pinata" ? "pinata" : null,
          },
        );
        uri = (uploadedMetadata as { metadataUri: string }).metadataUri;
      }
      const creator = flags.get("creator")
        ? slrd.resolveWallet(flags.get("creator")!).address
        : slrd.signer(wallet).publicKey;
      const deployment = await slrd.prepareTokenDeployment(launchpad, wallet, {
        name,
        symbol,
        uri,
        creator,
        mayhemMode: flags.has("mayhem"),
        cashback: flags.has("cashback"),
      });
      const plan = await slrd
        .transaction(wallet)
        .addMany(deployment.instructions, {
          kind: "deploy-token",
          mint: deployment.mint.publicKey,
          meta: { launchpad, name, symbol },
        })
        .withSigner(deployment.mint)
        .build();
      const header = {
        launchpad,
        mint: deployment.mint.publicKey.toBase58(),
        name,
        symbol,
        uri,
        uploadedMetadata,
        live: flags.has("live"),
      };
      if (!flags.has("live")) {
        const simulation = await slrd.simulatePlan(plan);
        emit(json({ ...header, simulation }) + "\n");
        return;
      }
      const receipt = await slrd.sendPlan(
        plan,
        flags.get("sender") ?? "rpc",
        `deploy:${launchpad}`,
        {
          skipSimulation: flags.has("skip-simulation"),
          skipPreflight: flags.has("skip-simulation"),
        },
      );
      const token = slrd.persistPreparedDeployment(
        deployment,
        flags.get("alias"),
      );
      emit(json({ ...header, receipt, token }) + "\n");
      return;
    }
    if (
      command === "token" &&
      (values[0] === "backfill" ||
        values[0] === "trades" ||
        values[0] === "analyze")
    ) {
      const { runTokenHistoryCommand } =
        await import("./token-history-command.ts");
      await runTokenHistoryCommand({
        slrd,
        action: values[0]!,
        values: values.slice(1),
        flags,
        emit,
      });
      return;
    }
    if (
      command === "token" &&
      values[0] !== "set" &&
      values[0] !== "refresh" &&
      values[0] !== "backfill" &&
      values[0] !== "trades" &&
      values[0] !== "analyze"
    ) {
      const [mint, name] = values;
      if (!mint) throw new Error("Usage: slrd token <token_ca> [name]");
      const metadata = flags.get("metadata-json");
      const token = await slrd.addToken(
        mint,
        name,
        metadata ? { metadataJson: metadata } : {},
      );
      emit(
        `${OWL} token ${token.name ?? token.symbol ?? "-"} ${token.mint} venue=${token.venueHint}\n`,
      );
      return;
    }
    if (command === "token" && values[0] === "refresh") {
      const ref = values[1];
      if (!ref) throw new Error("Usage: slrd token refresh <token|ca>");
      emit(json(await slrd.refreshToken(ref)) + "\n");
      return;
    }
    if (command === "token" && values[0] === "set") {
      const ref = values[1];
      if (!ref) throw new Error("Usage: slrd token set <token|ca> [flags]");
      const patch: Partial<TokenRow> = {};
      if (flags.get("pool")) patch.pool = flags.get("pool");
      if (flags.get("quote-mint")) patch.quoteMint = flags.get("quote-mint");
      if (flags.get("quote-program"))
        patch.quoteTokenProgram = flags.get("quote-program");
      if (flags.get("metadata-json"))
        patch.metadataJson = flags.get("metadata-json");
      const token = slrd.configureToken(ref, patch);
      emit(`${OWL} updated ${token.name ?? shortKey(token.mint)}\n`);
      return;
    }
    if (command === "tokens") {
      for (const token of slrd.tokens.list())
        emit(
          `${token.name ?? "-"}\t${token.symbol ? "$" + token.symbol : "-"}\t${token.mint}\t${token.venueHint}\n`,
        );
      return;
    }
    if (command === "quote" && values[0] === "buy") {
      const tokenRef = values[1];
      if (!tokenRef)
        throw new Error(
          "Usage: slrd quote buy <token|ca> --sol <amount> [--slippage-bps 1500]",
        );
      const spend = need(flags, "sol");
      const result = await slrd.quoteBuy(
        tokenRef,
        sol(spend),
        int(flags, "slippage-bps", 1500),
      );
      emit(
        json({
          token: {
            mint: result.token.mint,
            name: result.token.name,
            symbol: result.token.symbol,
          },
          venue: result.venue,
          quoteAsset:
            result.quoteAsset.kind === "native-sol"
              ? "SOL"
              : result.quoteAsset.mint.toBase58(),
          spendRaw: result.quote.inputRaw,
          expectedOutputRaw: result.quote.expectedOutputRaw,
          minimumOutputRaw: result.quote.minimumOutputRaw,
          meta: result.quote.meta ?? {},
        }) + "\n",
      );
      return;
    }
    if (command === "price" && values[0] === "average") {
      const tokenRef = values[1];
      if (!tokenRef)
        throw new Error("Usage: slrd price average <token|ca> --period 15m");
      const token = slrd.resolveToken(tokenRef);
      const window = slrd.averagePrice(
        token,
        duration(flags.get("period"), 60_000),
      );
      emit(
        `${token.symbol ? "$" + token.symbol : (token.name ?? shortKey(token.mint))} samples=${window.samples} avg=${formatPrice(window.averagePriceQuotePerToken)} min=${formatPrice(window.minimumPriceQuotePerToken)} max=${formatPrice(window.maximumPriceQuotePerToken)} last=${formatPrice(window.lastPriceQuotePerToken)}\n`,
      );
      return;
    }
    if (command === "price" && values[0] === "watch") {
      const tokenRefs = values.slice(1);
      if (tokenRefs.length === 0)
        throw new Error(
          "Usage: slrd price watch <token|ca...> [--interval 1s] [--period 1m]",
        );
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      for await (const event of slrd.watchPrices(tokenRefs, {
        intervalMs: duration(flags.get("interval"), 1_000),
        averagePeriodMs: duration(flags.get("period"), 60_000),
        signal: controller.signal,
      })) {
        const label = event.token.symbol
          ? "$" + event.token.symbol
          : (event.token.name ?? shortKey(event.token.mint));
        emit(
          `${new Date(event.sample.capturedAtMs).toISOString()} ${label} venue=${event.sample.venue} price=${formatPrice(event.sample.priceQuotePerToken)} avg=${formatPrice(event.average.averagePriceQuotePerToken)} samples=${event.average.samples}\n`,
        );
      }
      return;
    }
    if (command === "price") {
      const tokenRef = values[0];
      if (!tokenRef) throw new Error("Usage: slrd price <token|ca>");
      const token = slrd.resolveToken(tokenRef);
      const sample = await slrd.samplePrice(token);
      const label = token.symbol
        ? "$" + token.symbol
        : (token.name ?? shortKey(token.mint));
      emit(
        `${label} venue=${sample.venue} price=${formatPrice(sample.priceQuotePerToken)} quote=${sample.quoteAsset.kind === "native-sol" ? "SOL" : shortKey(sample.quoteAsset.mint.toBase58())} captured=${new Date(sample.capturedAtMs).toISOString()}\n`,
      );
      return;
    }
    if (command === "liquidate" && (values[0] ?? "tokens") === "tokens") {
      const except = csv(flags.get("except"));
      if (except.length === 0) {
        throw new Error(
          "Usage: slrd liquidate tokens --except <token|mint>[,<token|mint>...] [--wallets <a,b,...>] [--burn-unsellable] [--simulate | --live]",
        );
      }
      if (flags.has("simulate") && flags.has("live")) {
        throw new Error("Use either --simulate or --live, not both");
      }

      const mode = flags.has("live")
        ? "LIVE"
        : flags.has("simulate")
          ? "SIMULATE"
          : "PLAN";

      emit(`LIQUIDATE ${mode}\n`);
      for (const ref of except) {
        const mint = resolveTokenMintForPolicy(slrd, ref);
        emit(`PROTECT  ${ref} -> ${mint}\n`);
      }
      emit(
        `RPC      hard limit ${process.env.SLRD_RPC_MAX_RPS ?? "5"} req/s\n`,
      );

      const showAction = (
        prefix: string,
        index: number,
        total: number,
        action: {
          walletName: string;
          mint: string;
          symbol: string | null;
          name: string | null;
          amountUi: string;
          kind: string;
        },
      ) => {
        const label = action.symbol ?? action.name ?? shortKey(action.mint);
        emit(
          `${prefix} ${index}/${total}  @${action.walletName}  ` +
            `${action.kind === "unwrap-wsol" ? "WSOL" : label}  ${action.amountUi}` +
            `${action.kind === "close-empty" ? "  [close empty account]" : ""}\n`,
        );
      };

      const options = {
        except,
        walletRefs: csv(flags.get("wallets")),
        slippageBps: int(flags, "slippage-bps", 1500) ?? 1500,
        via: flags.get("sender") ?? "rpc",
        delayMs: int(flags, "delay-ms", 0) ?? 0,
        routeDelayMs: int(flags, "route-delay-ms", 0) ?? 0,
        portfolioConcurrency: 1,
        portfolioDelayMs: 0,
        jupiterFallback: !flags.has("no-jupiter"),
        burnUnsellable: flags.has("burn-unsellable"),
        onProgress: (event: any) => {
          if (event.stage === "portfolio-start") {
            emit("SCAN     wallet token accounts...\n");
          } else if (event.stage === "portfolio-done") {
            emit(
              `SCAN     ${event.wallets} wallets, ${event.holdings} holdings, ` +
                `${event.distinctMints} mints\n`,
            );
          } else if (event.stage === "route") {
            emit(
              `ROUTE    ${event.index}/${event.total}  ${shortKey(event.mint)}\n`,
            );
          } else if (event.stage === "action-start") {
            showAction(
              flags.has("simulate") ? "SIM " : "DO  ",
              event.index,
              event.total,
              event.action,
            );
          } else if (event.stage === "action-done") {
            showAction("OK  ", event.index, event.total, event.action);
          } else if (event.stage === "action-error") {
            showAction("FAIL", event.index, event.total, event.action);
            emit(`         ${event.error}\n`);
          }
        },
      };

      const plan = await planRegistryTokenLiquidation(slrd, options);
      emit(
        `PLAN     native=${plan.totals.sell}  jupiter=${plan.totals.jupiterSell}  ` +
          `unwrap=${plan.totals.unwrapWsol}  close-empty-now=${plan.totals.closeEmpty}  ` +
          `keep=${plan.totals.keepProtected}  unsupported=${plan.totals.skipUnsupported}\n`,
      );

      if (!flags.has("simulate") && !flags.has("live")) {
        const actionable = plan.actions.filter(
          (action) =>
            action.kind === "sell" ||
            action.kind === "jupiter-sell" ||
            action.kind === "unwrap-wsol" ||
            action.kind === "close-empty",
        );
        for (const action of actionable) {
          const label = action.symbol ?? action.name ?? shortKey(action.mint);
          const verb =
            action.kind === "unwrap-wsol"
              ? "UNWRAP"
              : action.kind === "close-empty"
                ? "CLOSE"
                : action.kind === "jupiter-sell"
                  ? "JUPITER"
                  : "SELL";
          emit(
            `${verb.padEnd(7)} @${action.walletName.padEnd(16)} ` +
              `${label.padEnd(14)} ${action.amountUi}` +
              `${action.venue ? `  ${action.venue}` : ""}\n`,
          );
        }

        emit(
          `KEEP     ${plan.totals.keepProtected} protected SLRD holding(s)\n` +
            `SKIP     ${plan.totals.skipUnsupported} unsupported/no-liquidity holding(s)`,
        );
        if (plan.totals.skipUnsupported > 0) {
          emit(flags.has("verbose") ? "\n" : "  (use --verbose to list)\n");
          if (flags.has("verbose")) {
            for (const action of plan.actions.filter(
              (item) => item.kind === "skip-unsupported",
            )) {
              const label =
                action.symbol ?? action.name ?? shortKey(action.mint);
              emit(
                `SKIP     @${action.walletName.padEnd(16)} ` +
                  `${label.padEnd(14)} ${action.amountUi}  ${action.reason ?? "unsupported"}\n`,
              );
            }
          }
        } else {
          emit("\n");
        }
        emit(
          `AUTO-CLOSE  after successful liquidation, the command re-scans on-chain state and closes every unprotected token account that is actually zero.\n`,
        );
        emit(`\n${OWL} plan only. Use --simulate, then --live.\n`);
        return;
      }

      const results = flags.has("simulate")
        ? await simulateRegistryTokenLiquidation(slrd, plan, options)
        : await executeRegistryTokenLiquidation(slrd, plan, options);

      const failed = results.filter((result) => Boolean(result.error)).length;
      const succeeded = results.filter((result) => !result.error);
      const soldNative = succeeded.filter(
        (result) => result.action.kind === "sell",
      ).length;
      const soldJupiter = succeeded.filter(
        (result) => result.action.kind === "jupiter-sell",
      ).length;
      const unwrapped = succeeded.filter(
        (result) => result.action.kind === "unwrap-wsol",
      ).length;
      const closedEmpty = succeeded.filter(
        (result) => result.action.kind === "close-empty",
      ).length;
      const reclaimedRentLamports = succeeded
        .filter((result) => result.action.kind === "close-empty")
        .reduce((sum, result) => sum + (result.action.rentLamports ?? 0n), 0n);
      emit(
        `DONE     ok=${succeeded.length}  failed=${failed}  ` +
          `native-sold=${soldNative}  jupiter-sold=${soldJupiter}  ` +
          `unwrapped=${unwrapped}  closed-empty=${closedEmpty}  ` +
          `reclaimed-rent≈${(Number(reclaimedRentLamports) / 1e9).toFixed(6)} SOL\n`,
      );
      return;
    }

    if (command === "sweep" && values[0] === "sol") {
      const destinationInput = flags.get("to") ?? values[1];
      if (!destinationInput || destinationInput === "true") {
        throw new Error(
          "Usage: slrd sweep sol --to <contact|wallet|address> [--wallets <a,b,...>] [--max-balance-sol <SOL>] [--exclude-group <group>] [--exclude-prefix <prefix>] [--keep <wallet=SOL,...>] [--keep-if-tokens <SOL> | --keep-if-token <token>=<SOL>] [--simulate | --live] [--json]",
        );
      }

      const destination = resolveDestinationRef(slrd, destinationInput);

      const keepSolByWallet: Record<string, string> = {};
      const keep = flags.get("keep");
      if (keep && keep !== "true") {
        for (const entry of keep.split(",")) {
          const [wallet, amount, ...extra] = entry.split("=");
          if (!wallet?.trim() || !amount?.trim() || extra.length) {
            throw new Error(
              `Invalid --keep entry ${entry}; expected wallet=SOL`,
            );
          }
          keepSolByWallet[wallet.trim()] = amount.trim();
        }
      }

      const excludeGroups = csv(flags.get("exclude-group"));
      const excludePrefixes = csv(flags.get("exclude-prefix"));
      const includeWallets = csv(flags.get("wallets"));

      const keepIfTokenRaw = flags.get("keep-if-token");
      let keepSolIfToken: { token: string; sol: string } | undefined;
      if (keepIfTokenRaw && keepIfTokenRaw !== "true") {
        const separator = keepIfTokenRaw.lastIndexOf("=");
        if (separator <= 0 || separator >= keepIfTokenRaw.length - 1) {
          throw new Error(
            "--keep-if-token expects <token|mint>=<SOL>, for example slrd=0.1",
          );
        }
        keepSolIfToken = {
          token: keepIfTokenRaw.slice(0, separator).trim(),
          sol: keepIfTokenRaw.slice(separator + 1).trim(),
        };
      }
      if (flags.get("keep-if-tokens") && keepSolIfToken) {
        throw new Error(
          "Use either --keep-if-tokens or --keep-if-token, not both",
        );
      }

      const sweepMode = flags.has("live")
        ? "LIVE"
        : flags.has("simulate")
          ? "SIMULATE"
          : "PLAN";
      if (!flags.has("json")) {
        emit(`SWEEP ${sweepMode}  to=${destination.address}\n`);
        emit(
          `RPC      hard limit ${process.env.SLRD_RPC_MAX_RPS ?? "5"} req/s\n`,
        );
      }

      const options = {
        destination: destination.address,
        excludeGroups,
        excludePrefixes,
        includeWallets: includeWallets.length ? includeWallets : undefined,
        maxBalanceSol: flags.get("max-balance-sol"),
        keepSolByWallet,
        defaultKeepSol: flags.get("default-keep-sol") ?? "0",
        keepSolIfTokens: flags.get("keep-if-tokens"),
        keepSolIfToken,
        tokenScanConcurrency: Math.max(
          1,
          Math.min(8, Math.trunc(int(flags, "rpc-concurrency", 1) ?? 1)),
        ),
        tokenScanDelayMs: Math.max(
          0,
          Math.trunc(int(flags, "rpc-delay-ms", 75) ?? 75),
        ),
        delayMs: int(flags, "delay-ms", 0) ?? 0,
        onProgress: flags.has("json")
          ? undefined
          : (event: any) => {
              if (event.stage === "plan-start") {
                emit(`PLAN     ${event.wallets} candidate wallets\n`);
              } else if (event.stage === "plan-ready") {
                emit(
                  `PLAN     ${event.sendWallets}/${event.wallets} will send, ` +
                    `${formatRaw(event.totalSendLamports, 9)} SOL total\n`,
                );
              } else if (event.stage === "wallet-start") {
                emit(
                  `SEND     ${event.index}/${event.total}  @${event.row.walletName}  ` +
                    `${formatRaw(event.row.sendLamports, 9)} SOL\n`,
                );
              } else if (event.stage === "wallet-done") {
                emit(
                  `OK       ${event.index}/${event.total}  @${event.row.walletName}\n`,
                );
              } else if (event.stage === "wallet-error") {
                emit(
                  `FAIL     ${event.index}/${event.total}  @${event.row.walletName}  ` +
                    `${event.error}\n`,
                );
              }
            },
      };
      const plan = await planRegistrySolSweep(slrd, options);

      const printablePlan = {
        mode: flags.has("live")
          ? "live"
          : flags.has("simulate")
            ? "simulate"
            : "plan",
        destination: {
          input: destination.input,
          address: plan.destination,
          contact: destination.contactName ?? null,
          wallet: destination.walletName ?? null,
        },
        totalSendSol: formatRaw(plan.totalSendLamports, 9),
        rows: plan.rows.map((row) => ({
          wallet: row.walletName,
          address: row.walletAddress,
          balanceSol: formatRaw(row.balanceLamports, 9),
          keepSol: formatRaw(row.keepLamports, 9),
          feeSol: formatRaw(row.feeLamports, 9),
          sendSol: formatRaw(row.sendLamports, 9),
          tokenHoldings: row.tokenHoldingCount,
          tokenScanComplete: row.tokenScanComplete,
          reserveReason: row.reserveReason ?? null,
          reserveTokenMint: row.reserveTokenMint ?? null,
          reserveTokenAmountRaw: row.reserveTokenAmountRaw?.toString() ?? null,
          skippedReason: row.skippedReason ?? null,
        })),
      };

      if (!flags.has("simulate") && !flags.has("live")) {
        if (flags.has("json")) {
          emit(json(printablePlan) + "\n");
          return;
        }

        emit(
          `SWEEP PLAN  to=${plan.destination}  ` +
            `send=${formatRaw(plan.totalSendLamports, 9)} SOL  ` +
            `wallets=${plan.rows.filter((row) => row.sendLamports > 0n).length}/${plan.rows.length}\n`,
        );

        for (const row of plan.rows) {
          if (row.sendLamports <= 0n && !flags.has("show-skipped")) continue;
          emit(
            `${row.sendLamports > 0n ? "SEND" : "SKIP"}  ` +
              `@${row.walletName.padEnd(18)} ` +
              `balance=${formatRaw(row.balanceLamports, 9).padStart(12)}  ` +
              `keep=${formatRaw(row.keepLamports, 9).padStart(5)}  ` +
              `send=${formatRaw(row.sendLamports, 9).padStart(12)}` +
              `${row.reserveReason === "specific-token" ? "  keep-token=yes" : ""}` +
              `${row.skippedReason ? `  ${row.skippedReason}` : ""}\n`,
          );
        }

        emit(
          `\n${OWL} plan only; no signer was decrypted and nothing was submitted. ` +
            `Use --json for full details, then --simulate or --live.\n`,
        );
        return;
      }

      if (flags.has("simulate") && flags.has("live")) {
        throw new Error("Use either --simulate or --live, not both");
      }

      if (flags.has("simulate")) {
        const results = await simulateRegistrySolSweep(slrd, plan, options);
        if (flags.has("json")) {
          emit(json({ ...printablePlan, results }) + "\n");
        } else {
          const failed = results.filter(
            (result) => result.error || result.simulation?.success === false,
          ).length;
          emit(
            `SWEEP SIMULATION  attempted=${results.length}  ` +
              `ok=${results.length - failed}  failed=${failed}  ` +
              `to=${plan.destination}\n`,
          );
          for (const result of results) {
            if (!result.error && result.simulation?.success !== false) continue;
            emit(
              `FAIL  @${result.row.walletName}  ` +
                `${result.error ?? "simulation failed"}\n`,
            );
          }
        }
        return;
      }

      const receipts = await executeRegistrySolSweep(slrd, plan, options);
      if (flags.has("json")) {
        emit(json({ ...printablePlan, receipts }) + "\n");
      } else {
        const failed = receipts.filter((result) =>
          Boolean(result.error),
        ).length;
        emit(
          `SWEEP LIVE  attempted=${receipts.length}  ` +
            `ok=${receipts.length - failed}  failed=${failed}  ` +
            `to=${plan.destination}\n`,
        );
        for (const result of receipts) {
          if (!result.error) continue;
          emit(`FAIL  @${result.row.walletName}  ${result.error}\n`);
        }
      }
      return;
    }

    if (command === "transfer" || command === "send-sol") {
      const { runTransferCommand } = await import("./commands/transfer.ts");
      emit(json(await runTransferCommand({ slrd, values, flags })) + "\n");
      return;
    }

    if (command === "buy") {
      const { runSmartBuyCommand } = await import("./commands/buy.ts");
      emit(json(await runSmartBuyCommand({ slrd, values, flags })) + "\n");
      return;
    }
    if (command === "sell") {
      const { runSmartSellCommand } = await import("./commands/sell.ts");
      emit(json(await runSmartSellCommand({ slrd, values, flags })) + "\n");
      return;
    }
    if (
      command === "unwrap-wsol" ||
      (command === "unwrap" && values[0] === "wsol")
    ) {
      const targets = targetWallets(
        slrd,
        flags,
        "Usage: slrd unwrap-wsol (--wallet <wallet> | --wallets <w1,w2> | --group <group>).",
      );
      const destination = flags.get("destination");
      if (destination && targets.refs.length !== 1)
        throw new Error(
          "--destination is only supported with a single --wallet unwrap.",
        );
      const unwrapOptions = {
        via: flags.get("sender") ?? "rpc",
        destination,
        skipMissing: flags.has("ignore-missing") || flags.has("skip-missing"),
        skipSimulation: flags.has("skip-simulation"),
        skipPreflight:
          flags.has("skip-preflight") || flags.has("skip-simulation"),
      };

      const multiWallet = targets.refs.length > 1;
      const failFast = flags.has("fail-fast");

      // Multi-wallet/group unwrap is resilient by default. Do not let one
      // undecryptable wallet prevent unrelated wallets from recovering WSOL.
      // With --ignore-missing, probe the WSOL ATA using only the public wallet
      // address BEFORE asking the vault to decrypt the signer.
      if (multiWallet && !failFast) {
        const results: Array<Record<string, unknown>> = [];

        for (const walletRef of targets.refs) {
          const resolved = slrd.resolveWallet(walletRef);
          const address = resolved.address.toBase58();
          const label = resolved.row?.name ? `@${resolved.row.name}` : address;

          if (unwrapOptions.skipMissing) {
            const wsolAccount = wrappedSolAta(resolved.address);
            const account = await slrd
              .connection()
              .getAccountInfo(wsolAccount, "confirmed");

            if (!account) {
              results.push({
                wallet: walletRef,
                address,
                ok: true,
                skipped: "missing-wsol",
                wsolAccount: wsolAccount.toBase58(),
              });
              continue;
            }
          }

          try {
            if (flags.has("simulate-only")) {
              const plan = await slrd
                .tx(walletRef)
                .unwrapWsol({ skipMissing: unwrapOptions.skipMissing })
                .build();
              const simulation = await slrd.simulatePlan(plan);
              results.push({
                wallet: walletRef,
                address,
                ok: simulation.success,
                mode: "simulation",
                simulation,
              });
            } else {
              const receipt = await slrd.unwrapWsol(walletRef, unwrapOptions);
              results.push({
                wallet: walletRef,
                address,
                ok: true,
                receipt,
              });
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            results.push({
              wallet: walletRef,
              address,
              ok: false,
              error: message,
            });
            process.stderr.write(
              `${OWL} unwrap-wsol ${label} (${address}) failed: ${message}\n`,
            );
          }
        }

        const succeeded = results.filter(
          (row) => row.ok === true && !row.skipped,
        ).length;
        const skipped = results.filter((row) => Boolean(row.skipped)).length;
        const failed = results.filter((row) => row.ok === false).length;

        emit(
          json({
            mode: flags.has("simulate-only")
              ? "wallet-by-wallet-simulation"
              : "wallet-by-wallet",
            target: targets,
            summary: {
              total: results.length,
              succeeded,
              skipped,
              failed,
            },
            results,
          }) + "\n",
        );
        return;
      }

      // Single-wallet unwrap remains fail-fast. --fail-fast also preserves the
      // old batch behavior for callers that explicitly want all-or-nothing.
      if (flags.has("simulate-only")) {
        const plans =
          targets.refs.length === 1
            ? [
                await slrd
                  .tx(targets.refs[0]!)
                  .unwrapWsol({
                    destination,
                    skipMissing: unwrapOptions.skipMissing,
                  })
                  .build(),
              ]
            : await slrd
                .composeMany(targets.refs)
                .unwrapWsol({ skipMissing: unwrapOptions.skipMissing })
                .build();
        const results = await Promise.all(
          plans.map((plan) => slrd.simulatePlan(plan)),
        );
        emit(json({ mode: "simulation", target: targets, results }) + "\n");
        return;
      }

      const receipts =
        targets.refs.length === 1
          ? await slrd.unwrapWsol(targets.refs[0]!, unwrapOptions)
          : await slrd.unwrapWsolMany(targets.refs, unwrapOptions);
      emit(json(receipts) + "\n");
      return;
    }
    if (command === "claim") {
      const token = values[0];
      if (!token)
        throw new Error("Usage: slrd claim <token|ca> --wallet <wallet>");
      emit(
        json(
          await slrd.claim(token, need(flags, "wallet"), {
            via: flags.get("sender") ?? "rpc",
          }),
        ) + "\n",
      );
      return;
    }
    if (command === "history") {
      emit(json(slrd.executions.history()) + "\n");
      return;
    }
    if (command === "group" && values[0] === "create") {
      const name = values[1];
      if (!name)
        throw new Error("Usage: slrd group create <name> [description]");
      emit(
        json(slrd.groups.create(name, values.slice(2).join(" ") || undefined)) +
          "\n",
      );
      return;
    }
    if (command === "group" && values[0] === "add") {
      const [_, group, wallet, weight] = values;
      if (!group || !wallet)
        throw new Error("Usage: slrd group add <group> <wallet> [weight_bps]");
      const resolved = slrd.resolveWallet(wallet);
      emit(
        json(
          slrd.groups.addWallet(
            group,
            resolved.address.toBase58(),
            weight ? Number(weight) : 10000,
          ),
        ) + "\n",
      );
      return;
    }
    if (command === "group" && values[0] === "add-many") {
      const group = values[1];
      const raw = values[2];
      if (!group || !raw)
        throw new Error(
          "Usage: slrd group add-many <group> <wallet1,wallet2,...>",
        );
      slrd.groups.create(group);
      const members = raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((ref) => {
          const resolved = slrd.resolveWallet(ref);
          return slrd.groups.addWallet(
            group,
            resolved.address.toBase58(),
            10000,
          );
        });
      emit(json({ group, added: members.length, members }) + "\n");
      return;
    }
    if (command === "group" && values[0] === "show") {
      const group = values[1];
      if (!group) throw new Error("Usage: slrd group show <group>");
      const members = slrd.groups.wallets(group).map((row) => {
        const wallet = slrd.resolveWallet(row.walletAddress);
        return {
          name: wallet.row?.name ?? null,
          address: wallet.address.toBase58(),
          weightBps: row.weightBps,
        };
      });
      emit(json({ group, members }) + "\n");
      return;
    }
    if (command === "group" && values[0] === "list") {
      emit(json(slrd.groups.list()) + "\n");
      return;
    }
    if (command === "agent" && values[0] === "create") {
      const name = values[1];
      if (!name)
        throw new Error(
          "Usage: slrd agent create <name> --wallet <wallet> [--config-json <json>]",
        );
      const supplied = flags.get("config-json")
        ? (JSON.parse(flags.get("config-json")!) as Record<string, unknown>)
        : {};
      const wallet = need(flags, "wallet");
      const agent = slrd.configureAgent(name, { ...supplied, wallet });
      emit(json(agent.row) + "\n");
      return;
    }
    if (command === "agent" && values[0] === "list") {
      emit(json(slrd.listAgents()) + "\n");
      return;
    }
    if (command === "watch" && values[0] === "token") {
      const ref = values[1];
      if (!ref) throw new Error("Usage: slrd watch token <token|ca> [label]");
      emit(json(slrd.watchToken(ref, values[2])) + "\n");
      return;
    }
    if (command === "watch" && values[0] === "wallet") {
      const ref = values[1];
      if (!ref) throw new Error("Usage: slrd watch wallet <wallet> [label]");
      emit(json(slrd.watchWallet(ref, values[2])) + "\n");
      return;
    }
    if (command === "watch" && values[0] === "program") {
      const address = values[1];
      if (!address)
        throw new Error("Usage: slrd watch program <address> [label]");
      emit(json(slrd.watchProgram(address, values[2])) + "\n");
      return;
    }
    if (command === "watch" && values[0] === "list") {
      emit(json(slrd.db.watches.select().where({ isActive: 1 }).all()) + "\n");
      return;
    }
    if (command === "alt" && values[0] === "add") {
      if (!values[1]) throw new Error("Usage: slrd alt add <address> [label]");
      emit(json(slrd.alts.register(values[1], values[2])) + "\n");
      return;
    }
    if (command === "alt" && values[0] === "list") {
      emit(json(slrd.alts.list()) + "\n");
      return;
    }
    if (command === "alt" && values[0] === "create") {
      emit(json(await slrd.createAlt(need(flags, "wallet"))) + "\n");
      return;
    }
    if (command === "alt" && values[0] === "extend") {
      if (!values[1] || values.length < 3)
        throw new Error(
          "Usage: slrd alt extend <address> --wallet <wallet> <account...>",
        );
      emit(
        json(
          await slrd.extendAlt(
            values[1],
            need(flags, "wallet"),
            values.slice(2),
          ),
        ) + "\n",
      );
      return;
    }
    throw new Error(`Unknown command: ${command}\n\n${help()}`);
  } finally {
    slrd.close();
  }
}
main().catch((error) => {
  const friendly = friendlyCliError(error);
  emit(
    friendly ? `${OWL} ${friendly}\n` : `${OWL} error: ${formatError(error)}\n`,
  );
  process.exitCode = 1;
});

export { formatCliError } from "./pump/token-launch-cli.ts";
