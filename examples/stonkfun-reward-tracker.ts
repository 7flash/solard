#!/usr/bin/env bun
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createTraderSolard, quoteJupiterTokenToSol } from "@solard/core";

const DEFAULT_XSOL = "4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs";
type Flags = Map<string, string>;
function args(argv: string[]): Flags {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (!v.startsWith("--")) continue;
    const [k, x] = v.slice(2).split("=", 2);
    if (x != null) m.set(k!, x);
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--"))
      m.set(k!, argv[++i]!);
    else m.set(k!, "true");
  }
  return m;
}
function flag(f: Flags, k: string) {
  const v = f.get(k);
  return v && v !== "true" ? v : undefined;
}
function required(f: Flags, k: string) {
  const v = flag(f, k);
  if (!v) throw new Error(`Missing --${k}`);
  return v;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const f = args(process.argv.slice(2));
  const walletRef = required(f, "wallet");
  const mint = flag(f, "reward-mint") ?? DEFAULT_XSOL;
  const interval = Math.max(5000, Number(flag(f, "interval-ms") ?? 30000));
  const out = resolve(
    flag(f, "out") ?? `.solard/rewards/${walletRef}-${mint.slice(0, 8)}.jsonl`,
  );
  mkdirSync(dirname(out), { recursive: true });
  const slrd = createTraderSolard();
  const wallet = slrd.resolveWallet(walletRef).address.toBase58();
  let previous: bigint | null = null;
  for (;;) {
    try {
      const rows = await slrd.tokenAccounts(wallet);
      const matching = rows.filter((r: any) => r.mint === mint);
      const raw = matching.reduce(
        (n: bigint, r: any) => n + BigInt(r.amountRaw ?? 0),
        0n,
      );
      const decimals = matching[0]?.decimals ?? null;
      let liquidationSol: number | null = null;
      if (raw > 0n) {
        try {
          const q = await quoteJupiterTokenToSol({
            inputMint: mint,
            amountRaw: raw,
          });
          liquidationSol = Number(q.outAmountRaw) / 1e9;
        } catch {}
      }
      const delta = previous == null ? 0n : raw - previous;
      const row = {
        at: new Date().toISOString(),
        wallet,
        rewardMint: mint,
        raw: raw.toString(),
        decimals,
        deltaRaw: delta.toString(),
        liquidationSol,
        attribution: "balance-delta-only",
      };
      appendFileSync(out, JSON.stringify(row) + "\n");
      console.log(
        `${row.at} xSOL=${raw}${delta === 0n ? "" : ` delta=${delta > 0n ? "+" : ""}${delta}`} value=${liquidationSol == null ? "-" : liquidationSol.toFixed(6) + " SOL"}`,
      );
      previous = raw;
    } catch (error) {
      console.error(
        "reward tracker:",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!f.has("loop")) break;
    await sleep(interval);
  }
  slrd.close();
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
