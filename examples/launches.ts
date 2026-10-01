#!/usr/bin/env bun
import { configure, createMeasure } from "measure-fn";
import { Connection } from "@solana/web3.js";
import {
  subscribeLaunches,
  type LaunchVenue,
  type TokenMetadataMode,
} from "@solard/sdk";

type Flags = Map<string, string>;

configure({ silent: false });
const m = createMeasure("slrd:launches-example", { maxResultLength: 2400 });

function parseArgs(argv: string[]): Flags {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    if (inline != null) flags.set(key!, inline);
    else if (argv[index + 1] && !argv[index + 1]!.startsWith("--"))
      flags.set(key!, argv[++index]!);
    else flags.set(key!, "true");
  }
  return flags;
}

function flag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function metadataMode(flags: Map<string, string>): TokenMetadataMode {
  const value = flags.get("metadata");
  if (value == null || value === "false" || value === "none") return false;
  if (value === "true") return "full";
  if (value === "chain" || value === "full") return value;
  throw new Error("--metadata must be chain, full, or omitted");
}

function venues(flags: Flags): LaunchVenue[] {
  const raw = flag(flags, "venues") ?? "pump,raydium-launchlab";
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of values)
    if (value !== "pump" && value !== "raydium-launchlab")
      throw new Error(`Unsupported launch venue: ${value}`);
  return [...new Set(values)] as LaunchVenue[];
}

const flags = parseArgs(process.argv.slice(2));
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
const includeMayhem = flags.has("include-mayhem");
const subscription = await subscribeLaunches({
  connection,
  venues: venues(flags),
  metadata: metadataMode(flags),
  signal: controller.signal,
  onLaunch(event) {
    if (event.isMayhemMode === true && !includeMayhem) return;
    m.sync(
      { start: () => "launch", end: (value: typeof event) => value },
      () => event,
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
