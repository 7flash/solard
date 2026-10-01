#!/usr/bin/env bun
import { configure, createMeasure } from "measure-fn";
import { Connection } from "@solana/web3.js";
import {
  subscribeMarketData,
  type MarketData,
  type TradeVenue,
} from "@solard/sdk";

type ParsedArgs = {
  flags: Map<string, string>;
  positionals: string[];
};

configure({ silent: false });
const m = createMeasure("slrd:market-data-example", { maxResultLength: 4000 });

function parseArgs(argv: string[]): ParsedArgs {
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
    else if (argv[index + 1] && !argv[index + 1]!.startsWith("--"))
      flags.set(key!, argv[++index]!);
    else flags.set(key!, "true");
  }
  return { flags, positionals };
}

function flag(flags: Map<string, string>, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function venues(flags: Map<string, string>): TradeVenue[] {
  const raw = flag(flags, "venues") ?? "pump,pumpswap,raydium-launchlab";
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of values)
    if (
      value !== "pump" &&
      value !== "pumpswap" &&
      value !== "raydium-launchlab"
    )
      throw new Error(`Unsupported market venue: ${value}`);
  return [...new Set(values)] as TradeVenue[];
}

function positiveNumber(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive number`);
  return parsed;
}

function printable(market: MarketData) {
  return {
    ...market,
    supplyRaw: market.supplyRaw.toString(),
    baseReserveRaw: market.baseReserveRaw.toString(),
    quoteReserveRaw: market.quoteReserveRaw.toString(),
  };
}

const parsed = parseArgs(process.argv.slice(2));
const flags = parsed.flags;
const tokens = [
  ...(flag(flags, "tokens")?.split(",") ?? []),
  ...(flag(flags, "token") ? [flag(flags, "token")!] : []),
  ...parsed.positionals,
]
  .map((value) => value.trim())
  .filter(Boolean);

if (!tokens.length)
  throw new Error(
    "Pass token mints as positionals or with --token <mint> / --tokens <mint,mint>",
  );

const rpc =
  flag(flags, "rpc") ??
  process.env.RPC_ENDPOINT?.trim() ??
  process.env.SOLANA_RPC_URL?.trim() ??
  process.env.HELIUS_RPC_URL?.trim();

if (!rpc)
  throw new Error(
    "Missing --rpc, RPC_ENDPOINT, SOLANA_RPC_URL, or HELIUS_RPC_URL",
  );

const ws =
  flag(flags, "ws") ??
  process.env.SOLANA_WS_URL?.trim() ??
  process.env.HELIUS_WS_URL?.trim();

const connection = new Connection(
  rpc,
  ws ? { commitment: "confirmed", wsEndpoint: ws } : "confirmed",
);
const controller = new AbortController();
const solUsd = positiveNumber(flag(flags, "sol-usd"), "--sol-usd");

const subscription = await subscribeMarketData({
  connection,
  tokens,
  venues: venues(flags),
  commitment: "confirmed",
  signal: controller.signal,
  solUsd,
  onMarket(market) {
    const value = printable(market);
    m.sync(
      { start: () => "market", end: (result: typeof value) => result },
      () => value,
    );
  },
  onStatus(event, data) {
    m.sync(
      { start: () => event, end: (value: Record<string, unknown>) => value },
      () => data ?? {},
    );
  },
});

const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await subscription.closed;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await subscription.close();
}
