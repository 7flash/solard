#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTraderSolard } from "@solard/sdk";

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

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function basis(path: string) {
  const parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as any;
  return {
    id: String(parsed.id ?? "").trim(),
    slot: Number(parsed.slot),
    hash: String(parsed.hash ?? "").trim(),
    observedAtMs:
      parsed.observedAtMs == null ? null : Number(parsed.observedAtMs),
  };
}

async function main(): Promise<void> {
  const flags = parse(process.argv.slice(2));
  const token = required(flags, "token");
  const wallet = required(flags, "wallet");
  const id = required(flags, "id");
  const basisPath = required(flags, "basis");
  const slrd = createTraderSolard();
  try {
    try {
      slrd.resolveToken(token);
    } catch {
      await slrd.addToken(token);
    }
    const result = await slrd.claims.creatorFees.claim(token, wallet, {
      id,
      basis: basis(basisPath),
      via: flags.get("sender") ?? "rpc",
      skipSimulation: flags.has("skip-simulation"),
      skipPreflight: flags.has("skip-preflight"),
    });
    process.stdout.write(
      json({
        claimId: result.claimId,
        tokenMint: result.tokenMint,
        feePayer: result.feePayer,
        quoteAsset: result.quoteAsset,
        payouts: result.payouts,
        receipt: result.receipt,
        checkpoint:
          result.claimedRaw == null
            ? null
            : {
                id: result.claimId,
                claimSignature: result.claimSignature,
                slot: result.claimSlot,
                claimedRaw: result.claimedRaw,
                observedAtMs: result.observedAtMs,
                basis: result.basis,
              },
      }) + "\n",
    );
  } finally {
    slrd.close();
  }
}

await main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
