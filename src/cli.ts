#!/usr/bin/env bun
import { emit } from "./core/ui.js";
import { shortKey } from "./core/log.js";
import { formatRaw } from "./core/amounts.js";
import {
  addManyWalletsToGroupAction,
  addTokenAction,
  addWalletToGroupAction,
  buyTokenAction,
  configureTokenAction,
  createGroupAction,
  createSolardActionContext,
  createWatchGroupAction,
  getJobAction,
  healthAction,
  importWalletAction,
  launchPumpTokenAction,
  listGroupsAction,
  listJobLogsAction,
  listJobsAction,
  listSmaAggregatesAction,
  listTokensAction,
  listWalletsAction,
  listWatchGroupsAction,
  listWatchesAction,
  refreshTokenAction,
  removeWatchGroupTokenAction,
  sellTokenAction,
  showGroupAction,
  toJson,
  watchAction,
  addWatchGroupTokenAction,
  type PumpLaunchInput,
} from "./solard/actions/index.js";

const OWL = "🦉";

type Flags = Map<string, string>;

type ParsedArgs = {
  command?: string;
  values: string[];
  flags: Flags;
};

export function parseCliArgs(input: string[]): ParsedArgs {
  const [command, ...rest] = input;
  const values: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index]!;
    if (current === "-w") {
      flags.set("wallet", rest[++index] ?? "");
      continue;
    }
    if (current.startsWith("--")) {
      const [key, inline] = current.slice(2).split("=", 2);
      if (inline != null) flags.set(key!, inline);
      else if (rest[index + 1] && !rest[index + 1]!.startsWith("-"))
        flags.set(key!, rest[++index]!);
      else flags.set(key!, "true");
      continue;
    }
    values.push(current);
  }
  return { command, values, flags };
}

function help(): string {
  return `${OWL} solard — CLI-first Solana wallet, watch, trade, and launch control plane

Core
  solard health [--json]
  solard start [--host 127.0.0.1] [--port 3000] [--open]

Wallets
  solard wallet import <private_key> [name] [--json]
  solard import <private_key> [name] [--json]
  solard wallets [--token <token>] [--show-zero] [--addresses-only] [--json]

Tokens and watches
  solard token add <mint> [name] [--metadata-json <json>] [--json]
  solard token <mint> [name] [--metadata-json <json>] [--json]
  solard token set <token|mint> [--pool <address>] [--quote-mint <mint>] [--quote-program <program>] [--metadata-json <json>] [--json]
  solard token refresh <token|mint> [--json]
  solard tokens [--json]
  solard watch token <token|mint> [label] [--json]
  solard watch wallet <wallet> [label] [--json]
  solard watch program <program> [label] [--json]
  solard watch list [--json]
  solard watch group list [--json]
  solard watch group create <name> [--json]
  solard watch group add <group_id> <mint> [--name <name>] [--symbol <symbol>] [--json]
  solard watch group remove <group_id> <mint> [--json]

Groups
  solard group create <name> [description] [--json]
  solard group add <group> <wallet> [weight_bps] [--json]
  solard group add-many <group> <wallet1,wallet2,...> [--json]
  solard group show <group> [--json]
  solard group list [--json]
  solard groups [--json]

Trading
  solard buy <token|mint> (--wallet <wallet> | --wallets <w1,w2> | --group <group>) --sol <amount> [--slippage-bps 1500] [--sender rpc|helius|helius-rpc|helius-fast|jito] [--live] [--json]
  solard sell <token|mint> (--wallet <wallet> | --wallets <w1,w2> | --group <group>) [--bps 10000] [--slippage-bps 1500] [--sender rpc|helius|helius-rpc|helius-fast|jito] [--live] [--json]

Market data
  solard sma [mint] [--interval-seconds 60] [--limit 100] [--json]

Jobs
  solard jobs [--status queued|running|succeeded|failed] [--limit 100] [--json]
  solard job <id> [--json]
  solard job logs <id> [--limit 500] [--json]

Launching
  solard launch pump --creator <wallet> (--uri <metadata_uri> | --metadata <json> | --image <path> --description <text>) --alias <name> --name <name> --symbol <symbol> [--buyer-group <group>] [--creator-buy-sol <amount>] [--live] [--json]

Safety
  Live trade and launch commands require both --live and SOLARD_ENABLE_LIVE_TRADES=1.
  Without --live, buy/sell/launch commands run simulation/dry-run mode.
`;
}

function flag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function has(flags: Flags, key: string): boolean {
  return flags.has(key) && flags.get(key) !== "false" && flags.get(key) !== "0";
}

function numberFlag(
  flags: Flags,
  key: string,
  fallback?: number,
): number | undefined {
  const value = flag(flags, key);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${value}`);
  return parsed;
}

function requiredFlag(flags: Flags, key: string): string {
  const value = flag(flags, key);
  if (!value) throw new Error(`Missing --${key} <value>`);
  return value;
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function jsonMode(flags: Flags): boolean {
  return has(flags, "json");
}

function writeResult(
  value: unknown,
  flags: Flags,
  human?: (value: any) => string,
): void {
  if (jsonMode(flags) || !human) emit(toJson(value) + "\n");
  else emit(human(value));
}

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

function targetFromFlags(flags: Flags) {
  return {
    wallet: flag(flags, "wallet"),
    wallets: splitCsv(flag(flags, "wallets")),
    group: flag(flags, "group"),
  };
}

function pumpInputFromCli(values: string[], flags: Flags): PumpLaunchInput {
  if (values[0] !== "pump" && values[0] !== "pump-token") {
    throw new Error("Usage: solard launch pump [flags]");
  }
  return {
    creator: requiredFlag(flags, "creator"),
    buyerGroup: flag(flags, "buyer-group"),
    buyPlanJson: flag(flags, "buy-plan-json"),
    buyPlanPath: flag(flags, "buy-plan"),
    metadataPath: flag(flags, "metadata"),
    alias: flag(flags, "alias"),
    name: flag(flags, "name"),
    symbol: flag(flags, "symbol"),
    uri: flag(flags, "uri"),
    imagePath: flag(flags, "image"),
    description: flag(flags, "description"),
    website: flag(flags, "website"),
    twitter: flag(flags, "twitter"),
    telegram: flag(flags, "telegram"),
    video: flag(flags, "video"),
    showName: has(flags, "hide-name") ? false : undefined,
    creatorBuySol: flag(flags, "creator-buy-sol"),
    creatorBuyLamports: flag(flags, "creator-buy-lamports"),
    creatorReserveSol: flag(flags, "creator-reserve-sol"),
    buyerMinBps: numberFlag(flags, "buyer-min-bps", undefined),
    buyerMaxBps: numberFlag(flags, "buyer-max-bps", undefined),
    buyerReserveSol: flag(flags, "buyer-reserve-sol"),
    deploymentSender: flag(flags, "deployment-sender"),
    buyerSender: flag(flags, "buyer-sender"),
    submitMode: flag(flags, "submit-mode"),
    senderTps: numberFlag(flags, "sender-tps", undefined),
    retryIntervalMs: numberFlag(flags, "retry-interval-ms", undefined),
    retryRecompileIntervalMs: numberFlag(
      flags,
      "retry-recompile-interval-ms",
      undefined,
    ),
    blockhashRefreshIntervalMs: numberFlag(
      flags,
      "blockhash-refresh-interval-ms",
      undefined,
    ),
    freshQuoteDelayMs: numberFlag(flags, "fresh-quote-delay-ms", undefined),
    retryTimeoutMs: numberFlag(flags, "retry-timeout-ms", undefined),
    maxFailedAttempts: numberFlag(flags, "max-failed-attempts", undefined),
    rateLimitBackoffMs: numberFlag(flags, "rate-limit-backoff-ms", undefined),
    retryJitterMs: numberFlag(flags, "retry-jitter-ms", undefined),
    heliusTipSol: flag(flags, "helius-tip-sol"),
    buyerPriorityMicroLamports: numberFlag(
      flags,
      "buyer-priority-micro-lamports",
      undefined,
    ),
    deploymentPriorityMicroLamports: numberFlag(
      flags,
      "deployment-priority-micro-lamports",
      undefined,
    ),
    slippageBps: numberFlag(flags, "slippage-bps", undefined),
    live: has(flags, "live"),
    skipSimulation: has(flags, "skip-simulation"),
    out: flag(flags, "out"),
  };
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const { command, values, flags } = parseCliArgs(argv);
  if (!command || command === "help" || command === "--help") {
    emit(help());
    return 0;
  }

  if (command === "health") {
    writeResult(
      healthAction(),
      flags,
      (value) =>
        `${OWL} health ok db=${value.db.path} rpc=${value.rpc.configured ? "configured" : "missing"} live=${value.env.SOLARD_ENABLE_LIVE_TRADES ? "enabled" : "disabled"}\n`,
    );
    return 0;
  }

  if (command === "launch") {
    const result = await launchPumpTokenAction(
      pumpInputFromCli(values, flags),
      {
        report: has(flags, "json")
          ? undefined
          : (label, value) => emit(`${label}: ${toJson(value)}\n`),
      },
    );
    writeResult(
      result,
      flags,
      (value) =>
        `${OWL} pump launch ${value.live ? "live" : "dry-run"} mint=${value.token.mint} alias=${value.token.alias}\n`,
    );
    return 0;
  }

  if (command === "jobs") {
    const result = await listJobsAction({
      status: flag(flags, "status"),
      limit: numberFlag(flags, "limit", 100),
      includeLogs: has(flags, "include-logs"),
    });
    writeResult(
      result,
      flags,
      (rows) =>
        rows
          .map(
            (job: any) =>
              `${job.status}\t${job.id}\t${new Date(job.createdAtMs).toISOString()}\t${job.input?.alias ?? job.input?.name ?? job.kind}`,
          )
          .join("\n") + "\n",
    );
    return 0;
  }

  if (command === "job") {
    if (values[0] === "logs") {
      const result = await listJobLogsAction({
        id: values[1] ?? "",
        limit: numberFlag(flags, "limit", 500),
      });
      writeResult(
        result,
        flags,
        (rows) =>
          rows
            .map(
              (entry: any) =>
                `${new Date(entry.atMs).toISOString()}\t${entry.label}\t${toJson(entry.value)}`,
            )
            .join("\n") + "\n",
      );
      return 0;
    }
    const result = await getJobAction({ id: values[0] ?? "" });
    writeResult(
      result,
      flags,
      (job) =>
        `${OWL} job ${job.status} ${job.id} ${job.input?.alias ?? job.input?.name ?? job.kind}\n`,
    );
    return 0;
  }

  const ctx = createSolardActionContext();
  try {
    if (
      command === "import" ||
      (command === "wallet" && values[0] === "import")
    ) {
      const offset = command === "wallet" ? 1 : 0;
      const privateKey = has(flags, "stdin")
        ? (await readStdin()).trim()
        : values[offset];
      const name = has(flags, "stdin") ? values[offset] : values[offset + 1];
      if (!privateKey)
        throw new Error("Usage: solard wallet import <private_key> [name]");
      const wallet = importWalletAction(ctx, { privateKey, name });
      writeResult(
        wallet,
        flags,
        (row) => `${OWL} imported @${row.name ?? "wallet"} ${row.address}\n`,
      );
      return 0;
    }

    if (command === "wallets") {
      const wallets = await listWalletsAction(ctx, {
        token: flag(flags, "token"),
        showZero: has(flags, "show-zero"),
      });
      if (has(flags, "addresses-only")) {
        for (const wallet of wallets)
          emit(
            `@${wallet.name ?? shortKey(wallet.address)}\t${wallet.address}\n`,
          );
      } else {
        writeResult(
          wallets,
          flags,
          (rows) =>
            rows
              .map((wallet: any) => {
                const holdings = (wallet.tokenBalances ?? [])
                  .map((balance: any) => `${balance.label}=${balance.amountUi}`)
                  .join("  ");
                const solText = wallet.solLamports
                  ? formatRaw(BigInt(wallet.solLamports), 9)
                  : "n/a";
                return `@${wallet.name ?? shortKey(wallet.address)}\t${wallet.address}\tSOL=${solText}${holdings ? `  ${holdings}` : ""}`;
              })
              .join("\n") + "\n",
        );
      }
      return 0;
    }

    if (
      command === "token" &&
      (values[0] === "add" ||
        (values[0] && values[0] !== "set" && values[0] !== "refresh"))
    ) {
      const offset = values[0] === "add" ? 1 : 0;
      const token = await addTokenAction(ctx, {
        mint: values[offset] ?? "",
        name: values[offset + 1],
        metadataJson: flag(flags, "metadata-json"),
      });
      writeResult(
        token,
        flags,
        (row) =>
          `${OWL} token ${row.name ?? row.symbol ?? "-"} ${row.mint} venue=${row.venueHint}\n`,
      );
      return 0;
    }

    if (command === "token" && values[0] === "set") {
      const token = configureTokenAction(ctx, {
        token: values[1] ?? "",
        pool: flag(flags, "pool"),
        quoteMint: flag(flags, "quote-mint"),
        quoteProgram: flag(flags, "quote-program"),
        metadataJson: flag(flags, "metadata-json"),
      });
      writeResult(
        token,
        flags,
        (row) =>
          `${OWL} updated ${row.name ?? row.symbol ?? shortKey(row.mint)}\n`,
      );
      return 0;
    }

    if (command === "token" && values[0] === "refresh") {
      const token = await refreshTokenAction(ctx, { token: values[1] ?? "" });
      writeResult(
        token,
        flags,
        (row) =>
          `${OWL} refreshed ${row.name ?? row.symbol ?? shortKey(row.mint)}\n`,
      );
      return 0;
    }

    if (command === "tokens") {
      const tokens = listTokensAction(ctx);
      writeResult(
        tokens,
        flags,
        (rows) =>
          rows
            .map(
              (token: any) =>
                `${token.name ?? "-"}\t${token.symbol ? "$" + token.symbol : "-"}\t${token.mint}\t${token.venueHint}`,
            )
            .join("\n") + "\n",
      );
      return 0;
    }

    if (command === "sma" || (command === "market" && values[0] === "sma")) {
      const mint = command === "sma" ? values[0] : values[1];
      const rows = await listSmaAggregatesAction(ctx, {
        mint: mint && !mint.startsWith("--") ? mint : flag(flags, "mint"),
        intervalSeconds: numberFlag(flags, "interval-seconds", undefined),
        limit: numberFlag(flags, "limit", 100),
      });
      writeResult(
        rows,
        flags,
        (items) =>
          items
            .map(
              (row: any) =>
                `${row.mint}\t${row.intervalSeconds}s\t${new Date(row.bucketStartMs).toISOString()}\tSMA=${row.smaMarketCapSol}\tlast=${row.lastMarketCapSol}\tn=${row.sampleCount}`,
            )
            .join("\n") + "\n",
      );
      return 0;
    }

    if (command === "watch") {
      if (values[0] === "group") {
        const sub = values[1] ?? "list";
        if (sub === "list") {
          const result = await listWatchGroupsAction();
          writeResult(
            result,
            flags,
            (rows) =>
              rows
                .map(
                  (group: any) =>
                    `${group.groupId ?? group.id ?? "-"}\t${group.name ?? "-"}\t${(group.tokens ?? []).length} tokens`,
                )
                .join("\n") + "\n",
          );
          return 0;
        }
        if (sub === "create") {
          const result = await createWatchGroupAction({
            name: values[2] ?? "",
          });
          writeResult(
            result,
            flags,
            (group) => `${OWL} watch group ${group.groupId ?? group.name}\n`,
          );
          return 0;
        }
        if (sub === "add") {
          const result = await addWatchGroupTokenAction({
            groupId: values[2] ?? "main",
            token: {
              mint: values[3] ?? "",
              name: flag(flags, "name"),
              symbol: flag(flags, "symbol"),
              source: "solard-cli",
            },
          });
          writeResult(
            result,
            flags,
            () => `${OWL} added ${values[3]} to ${values[2] ?? "main"}\n`,
          );
          return 0;
        }
        if (sub === "remove") {
          const result = await removeWatchGroupTokenAction({
            groupId: values[2] ?? "",
            mint: values[3] ?? "",
          });
          writeResult(
            result,
            flags,
            () => `${OWL} removed ${values[3]} from ${values[2]}\n`,
          );
          return 0;
        }
        throw new Error("Usage: solard watch group list|create|add|remove ...");
      }
      if (values[0] === "list") {
        writeResult(listWatchesAction(ctx), flags);
        return 0;
      }
      const kind = values[0] as "token" | "wallet" | "program" | undefined;
      if (!kind || !["token", "wallet", "program"].includes(kind))
        throw new Error(
          "Usage: solard watch token|wallet|program <ref> [label]",
        );
      const watch = watchAction(ctx, {
        kind,
        ref: values[1] ?? "",
        label: values[2],
      });
      writeResult(watch, flags, () => `${OWL} watching ${kind} ${values[1]}\n`);
      return 0;
    }

    if (command === "group" && values[0] === "create") {
      const group = createGroupAction(ctx, {
        name: values[1] ?? "",
        description: values.slice(2).join(" ") || undefined,
      });
      writeResult(group, flags);
      return 0;
    }
    if (command === "group" && values[0] === "add") {
      const row = addWalletToGroupAction(ctx, {
        group: values[1] ?? "",
        wallet: values[2] ?? "",
        weightBps: values[3] ? Number(values[3]) : 10000,
      });
      writeResult(row, flags);
      return 0;
    }
    if (command === "group" && values[0] === "add-many") {
      const result = addManyWalletsToGroupAction(ctx, {
        group: values[1] ?? "",
        wallets: splitCsv(values[2]),
      });
      writeResult(result, flags);
      return 0;
    }
    if (command === "group" && values[0] === "show") {
      writeResult(showGroupAction(ctx, { group: values[1] ?? "" }), flags);
      return 0;
    }
    if ((command === "group" && values[0] === "list") || command === "groups") {
      writeResult(listGroupsAction(ctx), flags);
      return 0;
    }

    if (command === "buy") {
      const result = await buyTokenAction(ctx, {
        token: values[0] ?? "",
        amountSol: requiredFlag(flags, "sol"),
        target: targetFromFlags(flags),
        slippageBps: numberFlag(flags, "slippage-bps", 1500),
        sender: flag(flags, "sender"),
        live: has(flags, "live"),
        skipSimulation: has(flags, "skip-simulation"),
        skipPreflight: has(flags, "skip-preflight"),
        priorityMicroLamports: numberFlag(
          flags,
          "priority-micro-lamports",
          undefined,
        ),
        cuLimit: numberFlag(flags, "cu-limit", undefined),
        tipSol: flag(flags, "tip-sol"),
      });
      writeResult(
        result,
        flags,
        (value) =>
          `${OWL} ${value.action} ${value.mode} target=${value.target.mode}:${value.target.refs.length}\n`,
      );
      return 0;
    }

    if (command === "sell") {
      const result = await sellTokenAction(ctx, {
        token: values[0] ?? "",
        target: targetFromFlags(flags),
        bps: numberFlag(flags, "bps", 10000),
        slippageBps: numberFlag(flags, "slippage-bps", 1500),
        sender: flag(flags, "sender"),
        live: has(flags, "live"),
        skipSimulation: has(flags, "skip-simulation"),
        skipPreflight: has(flags, "skip-preflight"),
      });
      writeResult(
        result,
        flags,
        (value) =>
          `${OWL} ${value.action} ${value.mode} target=${value.target.mode}:${value.target.refs.length}\n`,
      );
      return 0;
    }

    throw new Error(`Unknown command: ${command}\n\n${help()}`);
  } finally {
    ctx.close();
  }
}

export function formatCliError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

if (import.meta.main) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      emit(`${OWL} error: ${formatCliError(error)}\n`);
      process.exitCode = 1;
    });
}
