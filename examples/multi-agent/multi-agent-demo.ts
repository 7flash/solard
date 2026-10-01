#!/usr/bin/env bun
import slrd from "@solard/sdk";
import {
  calculateRuntime,
  getAllProcesses,
  getProcess,
  handleRun,
  isProcessRunning,
  readFileTail,
  terminateProcess,
} from "bgrun";

type Flags = Map<string, string>;
type StrategyName = "dip" | "momentum" | "range";

const PRICE_FEED_PROCESS = "solard-price-feed";
const PRICE_FEED_URL = "ws://127.0.0.1:8788/ws";
const PRICE_FEED_HEALTH = "http://127.0.0.1:8788/health";
const AGENT_PREFIX = "solard-demo-agent-";
const STRATEGIES: StrategyName[] = ["dip", "momentum", "range"];

function parseArgs(argv: string[]): {
  command: string;
  positionals: string[];
  flags: Flags;
} {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [key, inline] = value.slice(2).split("=", 2);
    if (inline != null) flags.set(key!, inline);
    else if (argv[index + 1] && !argv[index + 1]!.startsWith("--")) {
      flags.set(key!, argv[++index]!);
    } else flags.set(key!, "true");
  }
  return {
    command: positionals.shift() ?? "start",
    positionals,
    flags,
  };
}

function flag(flags: Flags, name: string): string | undefined {
  const value = flags.get(name);
  return value && value !== "true" ? value : undefined;
}

function numberFlag(flags: Flags, name: string, fallback: number): number {
  const raw = flag(flags, name);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
}

function boolFlag(flags: Flags, name: string): boolean {
  return flags.has(name) && !/^(0|false|no)$/i.test(flags.get(name) ?? "true");
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key === "BGR_PROCESS_NAME" ||
      key === "BGR_PARENT_NAME" ||
      key === "BGR_STDOUT" ||
      key === "BGR_STDERR" ||
      typeof value !== "string"
    ) {
      continue;
    }
    env[key] = value;
  }
  return { ...env, ...extra };
}

function safe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        safe(item),
      ]),
    );
  }
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(safe(value), null, 2)}\n`);
}

function shortMint(mint: string): string {
  return mint.slice(0, 7).replace(/[^a-zA-Z0-9]/g, "");
}

function walletName(mint: string, strategy: StrategyName): string {
  return `demo-${shortMint(mint)}-${strategy}`;
}

function processName(mint: string, strategy: StrategyName): string {
  return `${AGENT_PREFIX}${shortMint(mint)}-${strategy}`;
}

async function feedHealth(): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(PRICE_FEED_HEALTH, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return null;
    const value = await response.json();
    return value?.ok === true ? value : null;
  } catch {
    return null;
  }
}

async function waitForFeed(): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const health = await feedHealth();
    if (health) return health;
    await Bun.sleep(100);
  }
  throw new Error(`Price feed did not become healthy at ${PRICE_FEED_HEALTH}`);
}

async function ensureFeed(): Promise<Record<string, unknown>> {
  const healthy = await feedHealth();
  if (healthy) return healthy;
  const existing: any = getProcess(PRICE_FEED_PROCESS);
  if (!existing?.pid || !(await isProcessRunning(existing.pid))) {
    await handleRun({
      action: "run",
      name: PRICE_FEED_PROCESS,
      command: "bun run examples/price-feed-server.ts",
      directory: process.cwd(),
      env: cleanEnv({}),
      force: true,
      remoteName: "",
    } as any);
  }
  return await waitForFeed();
}

async function waitForSubscriptions(
  mint: string,
  expected: number,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const health = await feedHealth();
    const subscriptions = health?.subscriptions;
    const refs =
      subscriptions && typeof subscriptions === "object"
        ? Number((subscriptions as Record<string, unknown>)[mint] ?? 0)
        : 0;
    if (health && refs >= expected) return health;
    await Bun.sleep(100);
  }
  throw new Error(
    `Price feed did not receive ${expected} demo subscriptions for ${mint}`,
  );
}

function ensureWallet(name: string) {
  return (
    slrd.listWallets().find((wallet) => wallet.name === name) ??
    slrd.createWallet(name)
  );
}

async function waitForRunning(name: string): Promise<any> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const proc: any = getProcess(name);
    if (proc?.pid && (await isProcessRunning(proc.pid))) return proc;
    await Bun.sleep(100);
  }
  throw new Error(`Process ${name} did not start`);
}

async function prepare(mint: string): Promise<void> {
  if (!mint) {
    throw new Error(
      "Usage: bun examples/multi-agent-demo.ts prepare <token-mint>",
    );
  }
  if (!process.env.RPC_ENDPOINT?.trim())
    throw new Error("RPC_ENDPOINT is required");
  await slrd.addToken(mint);
  const wallets = STRATEGIES.map((strategy) => {
    const name = walletName(mint, strategy);
    const wallet = ensureWallet(name);
    return { strategy, wallet: name, address: wallet.address };
  });
  print({ ok: true, token: mint, wallets });
}

async function start(mint: string, flags: Flags): Promise<void> {
  if (!mint) {
    throw new Error(
      "Usage: bun examples/multi-agent-demo.ts start <token-mint> [--live] [--buy-sol 0.01] [--slippage-bps 500]",
    );
  }
  if (!process.env.RPC_ENDPOINT?.trim())
    throw new Error("RPC_ENDPOINT is required");
  const live = boolFlag(flags, "live");
  if (
    live &&
    !/^(1|true|yes)$/i.test(process.env.SOLARD_ENABLE_LIVE_TRADES?.trim() ?? "")
  ) {
    throw new Error("Live demo requires SOLARD_ENABLE_LIVE_TRADES=1");
  }
  await slrd.addToken(mint);
  const buySol = Math.max(0.000001, numberFlag(flags, "buy-sol", 0.01));
  const slippageBps = Math.max(
    0,
    Math.trunc(numberFlag(flags, "slippage-bps", 500)),
  );
  const cooldownMs = Math.max(
    0,
    Math.trunc(numberFlag(flags, "cooldown-ms", 8_000)),
  );
  const feed = await ensureFeed();
  const agents: Array<Record<string, unknown>> = [];
  for (const strategy of STRATEGIES) {
    const name = walletName(mint, strategy);
    const wallet = ensureWallet(name);
    const processId = processName(mint, strategy);
    const previous: any = getProcess(processId);
    if (previous?.pid && (await isProcessRunning(previous.pid))) {
      await terminateProcess(previous.pid);
    }
    await handleRun({
      action: "run",
      name: processId,
      command: "bun run examples/multi-agent-agent.ts",
      directory: process.cwd(),
      env: cleanEnv({
        SOLARD_DEMO_ID: `${shortMint(mint)}-${strategy}`,
        SOLARD_DEMO_TOKEN: mint,
        SOLARD_DEMO_WALLET: name,
        SOLARD_DEMO_STRATEGY: strategy,
        SOLARD_DEMO_LIVE: live ? "1" : "0",
        SOLARD_DEMO_BUY_SOL: String(buySol),
        SOLARD_DEMO_SLIPPAGE_BPS: String(slippageBps),
        SOLARD_DEMO_COOLDOWN_MS: String(cooldownMs),
        SOLARD_PRICE_FEED_URL: PRICE_FEED_URL,
      }),
      force: true,
      remoteName: "",
    } as any);
    const proc = await waitForRunning(processId);
    agents.push({
      strategy,
      process: processId,
      pid: proc.pid,
      wallet: name,
      address: wallet.address,
      live,
      buySol,
    });
  }
  const connectedFeed = await waitForSubscriptions(mint, STRATEGIES.length);
  print({
    ok: true,
    mode: live ? "live" : "paper",
    token: mint,
    feed: connectedFeed ?? feed,
    agents,
    commands: {
      status: "bun examples/multi-agent-demo.ts status",
      logs: `bun examples/multi-agent-demo.ts logs --mint ${mint}`,
      stop: `bun examples/multi-agent-demo.ts stop --mint ${mint}`,
    },
  });
}

async function demoProcesses(mint?: string): Promise<any[]> {
  const suffix = mint ? `${shortMint(mint)}-` : "";
  return (getAllProcesses() as any[]).filter((proc) =>
    String(proc?.name ?? "").startsWith(`${AGENT_PREFIX}${suffix}`),
  );
}

async function status(flags: Flags): Promise<void> {
  const mint = flag(flags, "mint");
  const processes = await demoProcesses(mint);
  const agents = await Promise.all(
    processes.map(async (proc) => ({
      process: proc.name,
      pid: proc.pid ?? null,
      running: Boolean(proc.pid && (await isProcessRunning(proc.pid))),
      runtime: proc.timestamp ? calculateRuntime(proc.timestamp) : null,
      stdout: proc.stdout_path ?? null,
      stderr: proc.stderr_path ?? null,
    })),
  );
  print({ ok: true, feed: await feedHealth(), agents });
}

async function logs(flags: Flags): Promise<void> {
  const mint = flag(flags, "mint");
  const strategy = flag(flags, "strategy");
  const lines = Math.max(
    1,
    Math.min(1_000, Math.trunc(numberFlag(flags, "lines", 80))),
  );
  const processes = (await demoProcesses(mint)).filter(
    (proc) => !strategy || String(proc.name).endsWith(`-${strategy}`),
  );
  const rows = await Promise.all(
    processes.map(async (proc) => ({
      process: proc.name,
      stdout: proc.stdout_path
        ? await readFileTail(proc.stdout_path, lines)
        : "",
      stderr: proc.stderr_path
        ? await readFileTail(proc.stderr_path, lines)
        : "",
    })),
  );
  print({ ok: true, logs: rows });
}

async function stop(flags: Flags): Promise<void> {
  const mint = flag(flags, "mint");
  const processes = await demoProcesses(mint);
  const stopped: string[] = [];
  for (const proc of processes) {
    if (proc.pid && (await isProcessRunning(proc.pid)))
      await terminateProcess(proc.pid);
    stopped.push(proc.name);
  }
  if (boolFlag(flags, "feed")) {
    const feed: any = getProcess(PRICE_FEED_PROCESS);
    if (feed?.pid && (await isProcessRunning(feed.pid)))
      await terminateProcess(feed.pid);
  }
  print({ ok: true, stopped, feedStopped: boolFlag(flags, "feed") });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "prepare")
    return await prepare(args.positionals[0] ?? "");
  if (args.command === "start")
    return await start(args.positionals[0] ?? "", args.flags);
  if (args.command === "status") return await status(args.flags);
  if (args.command === "logs") return await logs(args.flags);
  if (args.command === "stop") return await stop(args.flags);
  throw new Error("Command must be prepare, start, status, logs, or stop");
}

await main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => slrd.close());
