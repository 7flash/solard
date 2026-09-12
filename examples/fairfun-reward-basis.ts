#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
  if (value == null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
      .join(",")}}`;
  }
  throw new Error(`unsupported payload value: ${typeof value}`);
}

function hashEntitlementBasis(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

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
        hash: hashEntitlementBasis(payload),
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
