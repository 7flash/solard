#!/usr/bin/env bun
import { configure, createMeasure } from "measure-fn";
import slrd, {
  type TokenMetadataMode,
  type TradeEvent,
  type TradeVenue,
} from "@solard/sdk";

type ParsedArgs = {
  flags: Map<string, string>;
  positionals: string[];
};

configure({ silent: false });
const m = createMeasure("slrd:trades-example", { maxResultLength: 2400 });

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

function metadataMode(flags: Map<string, string>): TokenMetadataMode {
  const value = flags.get("metadata");
  if (value == null || value === "false" || value === "none") return false;
  if (value === "true") return "full";
  if (value === "chain" || value === "full") return value;
  throw new Error("--metadata must be chain, full, or omitted");
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
      throw new Error(`Unsupported trade venue: ${value}`);
  return [...new Set(values)] as TradeVenue[];
}

function printable(event: TradeEvent) {
  return {
    ...event,
    baseRaw: event.baseRaw?.toString() ?? null,
    quoteRaw: event.quoteRaw?.toString() ?? null,
    market: {
      ...event.market,
      supplyRaw: event.market.supplyRaw.toString(),
      baseReserveRaw: event.market.baseReserveRaw.toString(),
      quoteReserveRaw: event.market.quoteReserveRaw.toString(),
    },
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
if (flags.has("rpc") || flags.has("ws"))
  throw new Error(
    "Set only RPC_ENDPOINT in the environment. --rpc and --ws are intentionally unsupported in this example.",
  );
const controller = new AbortController();
const solUsdQuote = await slrd.getSolUsdPrice();
m.sync(
  { start: () => "sol-usd", end: (value: typeof solUsdQuote) => value },
  () => solUsdQuote,
);
const subscription = await slrd.listenTrades({
  tokens,
  venues: venues(flags),
  metadata: metadataMode(flags),
  signal: controller.signal,
  onStatus(event, data) {
    m.sync(
      { start: () => event, end: (value: Record<string, unknown>) => value },
      () => data ?? {},
    );
  },
});
subscription.onTrade((event) => {
  const value = printable(event);
  m.sync(
    { start: () => "trade", end: (result: typeof value) => result },
    () => value,
  );
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
