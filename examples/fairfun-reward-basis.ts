#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashRewardEntitlementBasis } from "@solard/sdk";

type Flags = Map<string, string>;

function parse(argv: string[]): Flags {
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

function required(flags: Flags, key: string): string {
  const value = flags.get(key);
  if (!value || value === "true") throw new Error(`Missing --${key} <value>`);
  return value;
}

async function main(): Promise<void> {
  const flags = parse(process.argv.slice(2));
  const id = required(flags, "id");
  const path = resolve(required(flags, "gravity"));
  const slot = Number(required(flags, "slot"));
  if (!Number.isInteger(slot) || slot < 0)
    throw new Error("--slot must be a non-negative integer");
  const payload = JSON.parse(readFileSync(path, "utf8"));
  process.stdout.write(
    `${JSON.stringify(
      {
        id,
        slot,
        hash: hashRewardEntitlementBasis(payload),
        observedAtMs: Date.now(),
      },
      null,
      2,
    )}\n`,
  );
}

await main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
