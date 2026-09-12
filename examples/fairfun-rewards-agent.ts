import { configure, createMeasure } from "measure-fn";
import { readFileSync } from "node:fs";
import { createTraderSolard } from "@solard/sdk";

type FairfunEntitlementSnapshot = {
  recipients: Array<{ wallet: string; entitledRaw: string }>;
  totalEntitledRaw?: string;
  observedAtMs: number | null;
};

configure({ silent: true });
const m = createMeasure("slrd:fairfun-rewards-agent", {
  maxResultLength: 1600,
});

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

function snapshot(path: string): FairfunEntitlementSnapshot {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as any;
  const rows = Array.isArray(parsed) ? parsed : parsed?.recipients;
  if (!Array.isArray(rows))
    throw new Error("Snapshot must be an array or { recipients: [...] }");
  return {
    recipients: rows.map((row: any) => ({
      wallet: String(row.wallet ?? row.address ?? ""),
      entitledRaw: String(
        row.entitledRaw ?? row.accumulatedRewardRaw ?? row.accumulatedRaw ?? "",
      ),
    })),
    totalEntitledRaw: Array.isArray(parsed)
      ? undefined
      : parsed.totalEntitledRaw == null
        ? undefined
        : String(parsed.totalEntitledRaw),
    observedAtMs: Array.isArray(parsed) ? null : (parsed.observedAtMs ?? null),
  };
}

function liveGate(): boolean {
  return [
    process.env.SOLARD_ENABLE_LIVE_TRADES,
    process.env.SLRD_ENABLE_LIVE_TRADES,
  ].some((value) => /^(1|true|yes)$/i.test(value?.trim() ?? ""));
}

export async function runFairfunRewardsAgent(
  argv = process.argv.slice(2),
): Promise<void> {
  const flags = parse(argv);
  const token = required(flags, "token");
  const wallet = required(flags, "wallet");
  const input = snapshot(required(flags, "snapshot"));
  const live = flags.has("live");
  const slrd = createTraderSolard();
  try {
    const common = {
      id: flags.get("id") ?? `fairfun:${token}`,
      from: wallet,
      asset: flags.get("reward-mint") ?? "SOL",
      entitlements: input.recipients.map((row) => ({
        recipient: row.wallet,
        entitledRaw: row.entitledRaw,
      })),
      reserveRaw: BigInt(flags.get("reserve-raw") ?? "0"),
      maxRecipientsPerTransaction: flags.get("max-per-tx")
        ? Number(flags.get("max-per-tx"))
        : undefined,
    };
    if (!live) {
      const plan = await m("plan", () => slrd.distributions.plan(common));
      process.stdout.write(
        `${JSON.stringify(plan, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`,
      );
      return;
    }
    if (!liveGate())
      throw new Error("--live requires SOLARD_ENABLE_LIVE_TRADES=1");
    const state = await m("distribute", () =>
      slrd.distributions.execute({
        ...common,
        via: flags.get("sender") ?? "rpc",
      }),
    );
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  } finally {
    slrd.close();
  }
}

if (import.meta.main) {
  runFairfunRewardsAgent().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
