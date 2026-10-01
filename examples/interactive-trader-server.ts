#!/usr/bin/env bun
import { configure, createMeasure } from "measure-fn";
import {
  InteractiveTraderEngine,
  type TraderCommand,
} from "./lib/interactive-trader-engine.ts";

configure({ silent: false });
const m = createMeasure("slrd:trader-server", { maxResultLength: 1600 });

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

function requiredSetting(flags: Flags, key: string, envKey: string): string {
  const value = setting(flags, key, envKey)?.trim();
  if (!value) throw new Error(`Missing --${key} or ${envKey}`);
  return value;
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

function liveEnabled(): boolean {
  return [
    process.env.SOLARD_ENABLE_LIVE_TRADES,
    process.env.SLRD_ENABLE_LIVE_TRADES,
    process.env.SOLWAL_ENABLE_LIVE_TRADES,
  ].some((value) => /^(1|true|yes)$/i.test(value?.trim() ?? ""));
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

function traderCommand(value: any): TraderCommand {
  const action = String(value?.action ?? "")
    .trim()
    .toLowerCase();
  if (action === "buy") return { action, sol: Number(value.sol) };
  if (action === "sell") return { action, percent: Number(value.percent) };
  if (action === "levels") {
    return {
      action,
      upPct: Number(value.upPct),
      sellPct: Number(value.sellPct),
      downPct: Number(value.downPct),
      buySol: Number(value.buySol),
    };
  }
  if (action === "pause" || action === "resume" || action === "clear") {
    return { action };
  }
  throw new Error("action must be buy, sell, levels, pause, resume, or clear");
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (!liveEnabled()) {
    throw new Error("Trader server requires SOLARD_ENABLE_LIVE_TRADES=1");
  }
  const tokenRef = requiredSetting(flags, "token", "SOLARD_TRADER_TOKEN");
  const walletRef = requiredSetting(flags, "wallet", "SOLARD_TRADER_WALLET");
  const host = setting(flags, "host", "SOLARD_TRADER_HOST") ?? "127.0.0.1";
  const port = Math.max(
    0,
    Math.trunc(numberSetting(flags, "port", "SOLARD_TRADER_PORT", 0)),
  );
  const apiToken = setting(flags, "api-token", "SOLARD_TRADER_API_TOKEN");
  if (host !== "127.0.0.1" && host !== "localhost" && !apiToken) {
    throw new Error(
      "A non-loopback trader server requires SOLARD_TRADER_API_TOKEN",
    );
  }
  const engine = new InteractiveTraderEngine({
    tokenRef,
    walletRef,
    slippageBps: numberSetting(
      flags,
      "slippage-bps",
      "SOLARD_TRADER_SLIPPAGE_BPS",
      500,
    ),
    intervalMs: numberSetting(
      flags,
      "interval-ms",
      "SOLARD_TRADER_INTERVAL_MS",
      1_000,
    ),
    settleMs: numberSetting(
      flags,
      "settle-ms",
      "SOLARD_TRADER_SETTLE_MS",
      1_500,
    ),
    settlementAttempts: numberSetting(
      flags,
      "settlement-attempts",
      "SOLARD_TRADER_SETTLEMENT_ATTEMPTS",
      24,
    ),
    launchlabProbeSol: numberSetting(
      flags,
      "launchlab-probe-sol",
      "SOLARD_TRADER_LAUNCHLAB_PROBE_SOL",
      0.001,
    ),
    autoRearmTargets:
      setting(flags, "auto-rearm", "SOLARD_TRADER_AUTO_REARM") !== "false",
    via: setting(flags, "via", "SOLARD_TRADER_VIA") ?? "rpc",
    priceFeedUrl:
      setting(flags, "price-feed", "SOLARD_PRICE_FEED_URL") ??
      "ws://127.0.0.1:8788/ws",
  });
  await engine.start();
  let stopping = false;
  let server: ReturnType<typeof Bun.serve>;
  server = Bun.serve({
    hostname: host,
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") {
        return response({ ok: true, mode: engine.mode, mint: engine.mint });
      }
      if (!authorized(request, apiToken))
        return errorResponse("Unauthorized", 401);
      if (url.pathname === "/info" && request.method === "GET") {
        return response({
          ok: true,
          trader: await engine.info(url.searchParams.get("fresh") !== "0"),
        });
      }
      if (url.pathname === "/command" && request.method === "POST") {
        try {
          const command = traderCommand(await bodyJson(request));
          const trader = await engine.command(command);
          return response({ ok: true, trader });
        } catch (error) {
          return errorResponse(error, engine.mode === "executing" ? 409 : 400);
        }
      }
      if (url.pathname === "/stop" && request.method === "POST") {
        if (!stopping) {
          stopping = true;
          setTimeout(() => {
            void engine.close().finally(() => server.stop(true));
          }, 25);
        }
        return response({ ok: true, stopping: true });
      }
      return errorResponse("Not found", 404);
    },
  });
  await m.measure(
    {
      start: () => "trader server ready",
      end: (value: {
        host: string;
        port: number;
        mint: string;
        wallet: string;
      }) => value,
    },
    async () => ({
      host,
      port: server.port,
      mint: engine.mint,
      wallet: walletRef,
    }),
  );
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void engine.close().finally(() => server.stop(true));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  m.sync(
    {
      start: () => "trader server error",
      end: (value: { error: string }) => value,
    },
    () => ({ error: message }),
  );
  process.exitCode = 1;
});
