import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  buildPumpExternalDeployment,
  createTraderSolard,
  type PumpExternalDeploymentBuild,
} from "@solard/core";

export type ExternalPumpFlags = Map<string, string>;

function parse(argv: string[]): ExternalPumpFlags {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) continue;
    const [key, inline] = item.slice(2).split("=", 2);
    if (inline != null) flags.set(key!, inline);
    else if (argv[index + 1] && !argv[index + 1]!.startsWith("--"))
      flags.set(key!, argv[++index]!);
    else flags.set(key!, "true");
  }
  return flags;
}

function value(flags: ExternalPumpFlags, key: string): string | undefined {
  const result = flags.get(key);
  return result && result !== "true" ? result : undefined;
}

function required(flags: ExternalPumpFlags, key: string): string {
  const result = value(flags, key);
  if (!result) throw new Error(`Missing --${key} <value>`);
  return result;
}

function integer(
  flags: ExternalPumpFlags,
  key: string,
  fallback: number,
): number {
  const raw = value(flags, key);
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`Invalid --${key}: ${raw}`);
  return Math.trunc(parsed);
}

function printable(build: PumpExternalDeploymentBuild) {
  return {
    version: build.version,
    launchpad: build.launchpad,
    transactionBase64: build.transactionBase64,
    payer: build.payer,
    mint: build.mint,
    beneficiary: build.beneficiary,
    pair: build.quoteKind === "native-sol" ? "SOL" : build.quoteMint,
    quoteMint: build.quoteMint,
    quoteKind: build.quoteKind,
    quoteDecimals: build.quoteDecimals,
    quoteTokenProgram: build.quoteTokenProgram,
    requiredSignerPubkeys: build.requiredSignerPubkeys,
    partialSignerPubkeys: build.partialSignerPubkeys,
    missingSignerPubkeys: build.missingSignerPubkeys,
    blockhash: build.blockhash,
    lastValidBlockHeight: build.lastValidBlockHeight,
    serializedSize: build.serializedSize,
    token: build.token,
    broadcast: false,
  };
}

/**
 * Prepare a Pump create_v2 transaction for Phantom or another external wallet.
 * No persisted Solard signing wallet is opened or decrypted, and nothing is sent.
 */
export async function runPumpExternalDeploymentFromArgs(
  argv: string[],
): Promise<ReturnType<typeof printable>> {
  const flags = parse(argv);
  if (flags.has("live")) {
    throw new Error(
      "External-wallet preparation never broadcasts. Remove --live, sign transactionBase64 with Phantom, then broadcast from the wallet/frontend.",
    );
  }

  const payer = required(flags, "payer");
  const name = required(flags, "name");
  const symbol = required(flags, "symbol");
  const uri = required(flags, "uri");
  const pair = value(flags, "pair") ?? value(flags, "quote-mint") ?? "SOL";
  const beneficiary = value(flags, "beneficiary") ?? payer;

  const slrd = createTraderSolard();
  try {
    const build = await buildPumpExternalDeployment({
      connection: slrd.connection(),
      payer,
      name,
      symbol,
      uri,
      pair,
      beneficiary,
      mayhemMode: flags.has("mayhem"),
      cashback: flags.has("cashback"),
      cuLimit: integer(flags, "cu-limit", 600_000),
      priorityMicroLamports: integer(flags, "priority-micro-lamports", 0),
    });
    const output = printable(build);
    const encoded = `${JSON.stringify(output, null, 2)}\n`;
    const out = value(flags, "out");
    if (out) {
      const path = resolve(out);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, encoded, { flag: "w" });
      process.stdout.write(
        `🦉 prepared Pump deployment\n` +
          `  mint         ${build.mint}\n` +
          `  payer        ${build.payer}  (Phantom signature required)\n` +
          `  beneficiary  ${build.beneficiary}\n` +
          `  pair         ${build.quoteKind === "native-sol" ? "SOL" : build.quoteMint}\n` +
          `  mint signer  signed\n` +
          `  broadcast    NO\n` +
          `  output       ${path}\n`,
      );
    } else {
      // The transaction is the product of this command, so stdout is machine-ready
      // JSON by default when no explicit output file is supplied.
      process.stdout.write(encoded);
    }
    return output;
  } finally {
    slrd.close();
  }
}
