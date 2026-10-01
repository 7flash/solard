#!/usr/bin/env bun
import { configure, createMeasure } from "measure-fn";
import { Connection } from "@solana/web3.js";
import { fetchTokenMetadata, type TokenMetadataMode } from "@solard/sdk";

type ParsedArgs = {
  flags: Map<string, string>;
  positionals: string[];
};

configure({ silent: false });
const m = createMeasure("slrd:token-metadata-example", {
  maxResultLength: 5000,
});

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

function mode(flags: Map<string, string>): Exclude<TokenMetadataMode, false> {
  const value = flag(flags, "metadata") ?? "full";
  if (value === "chain" || value === "full") return value;
  throw new Error("--metadata must be chain or full");
}

const parsed = parseArgs(process.argv.slice(2));
const mint = flag(parsed.flags, "mint") ?? parsed.positionals[0];
if (!mint) throw new Error("Pass a mint positionally or with --mint <mint>");
const rpc =
  flag(parsed.flags, "rpc") ??
  process.env.RPC_ENDPOINT?.trim() ??
  process.env.SOLANA_RPC_URL?.trim() ??
  process.env.HELIUS_RPC_URL?.trim();
if (!rpc)
  throw new Error(
    "Missing --rpc, RPC_ENDPOINT, SOLANA_RPC_URL, or HELIUS_RPC_URL",
  );
const ws =
  flag(parsed.flags, "ws") ??
  process.env.SOLANA_WS_URL?.trim() ??
  process.env.HELIUS_WS_URL?.trim();
const connection = new Connection(
  rpc,
  ws ? { commitment: "confirmed", wsEndpoint: ws } : "confirmed",
);

const metadata = await fetchTokenMetadata(connection, mint, {
  mode: mode(parsed.flags),
});

m.sync(
  {
    start: () => "metadata",
    end: (value: typeof metadata) => value,
  },
  () => metadata,
);
