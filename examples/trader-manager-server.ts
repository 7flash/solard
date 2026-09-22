#!/usr/bin/env bun
import { configure, createMeasure } from "measure-fn";
import {
  calculateRuntime,
  getAllProcesses,
  getProcess,
  getProcessPorts,
  handleRun,
  isProcessRunning,
  readFileTail,
  terminateProcess,
} from "bgrun";

configure({ silent: false });
const m = createMeasure("slrd:trader-manager", { maxResultLength: 1600 });

const PREFIX = "solard-trader-";

type Flags = Map<string, string>;

function parseArgs(argv: string[]): Flags {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    if (inline != null) flags.set(key!, inline);
    else if (argv[index + 1] && !argv[index + 1]!.startsWith("--")) {
      flags.set(key!, argv[++index]!);
    } else {
      flags.set(key!, "true");
    }
  }
  return flags;
}

function flag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function setting(
  flags: Flags,
  key: string,
  envKey: string,
): string | undefined {
  return flag(flags, key) ?? process.env[envKey];
}

function numberSetting(
  flags: Flags,
  key: string,
  envKey: string,
  fallback: number,
): number {
  const raw = setting(flags, key, envKey);
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
  return value;
}

function authorized(request: Request, token: string | undefined): boolean {
  if (!token) return true;
  return request.headers.get("authorization") === `Bearer ${token}`;
}

async function bodyJson(request: Request): Promise<any> {
  const text = await request.text();
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function errorResponse(error: unknown, status = 400): Response {
  return response(
    {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    },
    status,
  );
}

function cleanId(value: string): string {
  const id = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) throw new Error("Trader id is empty after normalization");
  return id.slice(0, 64);
}

function generatedId(token: string): string {
  return cleanId(`${token.slice(0, 8)}-${Date.now().toString(36)}`);
}

function processName(id: string): string {
  return `${PREFIX}${cleanId(id)}`;
}

function traderId(name: string): string {
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
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

function portNumbers(value: any): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      Number(typeof item === "number" ? item : (item?.port ?? item?.localPort)),
    )
    .filter((item) => Number.isInteger(item) && item > 0 && item <= 65535);
}

async function workerBaseUrl(name: string): Promise<string | null> {
  const proc: any = getProcess(name);
  if (!proc?.pid || !(await isProcessRunning(proc.pid))) {
    return null;
  }
  const ports = portNumbers(await getProcessPorts(proc.pid));
  for (const port of ports) {
    const base = `http://127.0.0.1:${port}`;
    try {
      const health = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (health.ok) return base;
    } catch {}
  }
  return null;
}

async function waitForWorker(name: string): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const base = await workerBaseUrl(name);
    if (base) return base;
    await Bun.sleep(100);
  }
  throw new Error(
    `Trader ${traderId(name)} started but its HTTP endpoint was not detected`,
  );
}

async function workerFetch(
  name: string,
  path: string,
  init: RequestInit | undefined,
  apiToken: string | undefined,
): Promise<any> {
  const base = await workerBaseUrl(name);
  if (!base)
    throw new Error(
      `Trader ${traderId(name)} is not running or has no HTTP endpoint`,
    );
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (apiToken) headers.set("authorization", `Bearer ${apiToken}`);
  const result = await fetch(`${base}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await result.json().catch(() => null);
  if (!result.ok) {
    throw new Error(payload?.error ?? `Trader HTTP ${result.status}`);
  }
  return payload;
}

async function processSummary(proc: any, apiToken: string | undefined) {
  const running = Boolean(proc?.pid && (await isProcessRunning(proc.pid)));
  const base = running ? await workerBaseUrl(proc.name) : null;
  let info: any = null;
  if (base) {
    try {
      info = await workerFetch(proc.name, "/info?fresh=0", undefined, apiToken);
    } catch {}
  }
  return {
    id: traderId(proc.name),
    name: proc.name,
    pid: proc.pid ?? null,
    running,
    url: base,
    runtime: proc.timestamp ? calculateRuntime(proc.timestamp) : null,
    trader: info?.trader ?? null,
  };
}

async function listTraders(apiToken: string | undefined) {
  const processes = (getAllProcesses() as any[]).filter((proc) =>
    String(proc?.name ?? "").startsWith(PREFIX),
  );
  return await Promise.all(
    processes.map((proc) => processSummary(proc, apiToken)),
  );
}

async function spawnTrader(args: {
  id?: string;
  token: string;
  wallet: string;
  slippageBps?: number;
  intervalMs?: number;
  settleMs?: number;
  settlementAttempts?: number;
  launchlabProbeSol?: number;
  autoRearm?: boolean;
  via?: string;
  apiToken?: string;
}) {
  const token = String(args.token ?? "").trim();
  const wallet = String(args.wallet ?? "").trim();
  if (!token) throw new Error("token is required");
  if (!wallet) throw new Error("wallet is required");
  if (
    !/^(1|true|yes)$/i.test(process.env.SOLARD_ENABLE_LIVE_TRADES?.trim() ?? "")
  ) {
    throw new Error(
      "Manager requires SOLARD_ENABLE_LIVE_TRADES=1 before spawning live traders",
    );
  }
  const id = cleanId(args.id ?? generatedId(token));
  const name = processName(id);
  const existing: any = getProcess(name);
  if (existing?.pid && (await isProcessRunning(existing.pid))) {
    throw new Error(`Trader ${id} is already running`);
  }
  await handleRun({
    action: "run",
    name,
    command: "bun run examples/interactive-trader-server.ts",
    directory: process.cwd(),
    env: cleanEnv({
      SOLARD_TRADER_TOKEN: token,
      SOLARD_TRADER_WALLET: wallet,
      SOLARD_TRADER_HOST: "127.0.0.1",
      SOLARD_TRADER_PORT: "0",
      SOLARD_TRADER_SLIPPAGE_BPS: String(args.slippageBps ?? 500),
      SOLARD_TRADER_INTERVAL_MS: String(args.intervalMs ?? 1_000),
      SOLARD_TRADER_SETTLE_MS: String(args.settleMs ?? 1_500),
      SOLARD_TRADER_SETTLEMENT_ATTEMPTS: String(args.settlementAttempts ?? 24),
      SOLARD_TRADER_LAUNCHLAB_PROBE_SOL: String(
        args.launchlabProbeSol ?? 0.001,
      ),
      SOLARD_TRADER_AUTO_REARM: String(args.autoRearm !== false),
      SOLARD_TRADER_VIA: args.via ?? "rpc",
      ...(args.apiToken ? { SOLARD_TRADER_API_TOKEN: args.apiToken } : {}),
    }),
    force: true,
    remoteName: "",
  } as any);
  await waitForWorker(name);
  const proc: any = getProcess(name);
  return await processSummary(proc, args.apiToken);
}

async function stopTrader(id: string) {
  const name = processName(id);
  const proc: any = getProcess(name);
  if (!proc) return { id: cleanId(id), existed: false, stopped: true };
  const running = Boolean(proc.pid && (await isProcessRunning(proc.pid)));
  if (running) await terminateProcess(proc.pid);
  return {
    id: traderId(name),
    existed: true,
    stopped: true,
    pid: proc.pid ?? null,
  };
}

async function traderLogs(id: string, lines: number) {
  const proc: any = getProcess(processName(id));
  if (!proc) throw new Error(`Unknown trader ${cleanId(id)}`);
  const count = Math.max(1, Math.min(1_000, Math.trunc(lines)));
  const [stdout, stderr] = await Promise.all([
    proc.stdout_path
      ? readFileTail(proc.stdout_path, count)
      : Promise.resolve(""),
    proc.stderr_path
      ? readFileTail(proc.stderr_path, count)
      : Promise.resolve(""),
  ]);
  return { id: traderId(proc.name), stdout, stderr };
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const host =
    setting(flags, "host", "SOLARD_TRADER_MANAGER_HOST") ?? "127.0.0.1";
  const port = Math.max(
    1,
    Math.trunc(
      numberSetting(flags, "port", "SOLARD_TRADER_MANAGER_PORT", 8787),
    ),
  );
  const apiToken = setting(flags, "api-token", "SOLARD_TRADER_MANAGER_TOKEN");
  if (host !== "127.0.0.1" && host !== "localhost" && !apiToken) {
    throw new Error(
      "A non-loopback manager requires SOLARD_TRADER_MANAGER_TOKEN",
    );
  }
  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") {
        return response({ ok: true, service: "solard-trader-manager" });
      }
      if (!authorized(request, apiToken))
        return errorResponse("Unauthorized", 401);
      try {
        if (url.pathname === "/traders" && request.method === "GET") {
          return response({ ok: true, traders: await listTraders(apiToken) });
        }
        if (url.pathname === "/traders" && request.method === "POST") {
          const body = await bodyJson(request);
          const trader = await spawnTrader({
            id: body.id == null ? undefined : String(body.id),
            token: String(body.token ?? ""),
            wallet: String(body.wallet ?? ""),
            slippageBps:
              body.slippageBps == null ? undefined : Number(body.slippageBps),
            intervalMs:
              body.intervalMs == null ? undefined : Number(body.intervalMs),
            settleMs: body.settleMs == null ? undefined : Number(body.settleMs),
            settlementAttempts:
              body.settlementAttempts == null
                ? undefined
                : Number(body.settlementAttempts),
            launchlabProbeSol:
              body.launchlabProbeSol == null
                ? undefined
                : Number(body.launchlabProbeSol),
            autoRearm:
              body.autoRearm == null ? undefined : Boolean(body.autoRearm),
            via: body.via == null ? undefined : String(body.via),
            apiToken,
          });
          return response({ ok: true, trader }, 201);
        }
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts[0] === "traders" && parts[1]) {
          const id = cleanId(parts[1]);
          const name = processName(id);
          if (parts.length === 2 && request.method === "GET") {
            const proc: any = getProcess(name);
            if (!proc) return errorResponse(`Unknown trader ${id}`, 404);
            return response({
              ok: true,
              trader: await processSummary(proc, apiToken),
            });
          }
          if (parts.length === 2 && request.method === "DELETE") {
            return response({ ok: true, trader: await stopTrader(id) });
          }
          if (parts[2] === "command" && request.method === "POST") {
            const body = await bodyJson(request);
            return response(
              await workerFetch(
                name,
                "/command",
                { method: "POST", body: JSON.stringify(body) },
                apiToken,
              ),
            );
          }
          if (parts[2] === "logs" && request.method === "GET") {
            return response({
              ok: true,
              logs: await traderLogs(
                id,
                Number(url.searchParams.get("lines") ?? "100"),
              ),
            });
          }
        }
        return errorResponse("Not found", 404);
      } catch (error) {
        return errorResponse(error, 400);
      }
    },
  });
  await m.measure(
    {
      start: () => "trader manager ready",
      end: (value: { host: string; port: number; bgrun: boolean }) => value,
    },
    async () => ({ host, port: server.port, bgrun: true }),
  );
  const stop = () => server.stop(true);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

await main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  m.sync(
    {
      start: () => "trader manager error",
      end: (value: { error: string }) => value,
    },
    () => ({ error: message }),
  );
  process.exitCode = 1;
});
