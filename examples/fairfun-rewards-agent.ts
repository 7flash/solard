import {
  configureSolardMeasure,
  createSolardMeasure,
  createTraderSolard,
} from "@solard/sdk";

configureSolardMeasure({ silent: false });
const m = createSolardMeasure("fairfun-rewards");

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
function raw(value: string | undefined, fallback = 0n): bigint {
  if (!value) return fallback;
  if (!/^\d+$/.test(value))
    throw new Error(`Expected raw integer amount: ${value}`);
  return BigInt(value);
}
function duration(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(value);
  if (!match) throw new Error(`Invalid duration ${value}`);
  const scale = ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const)[
    (match[2]?.toLowerCase() ?? "ms") as "ms" | "s" | "m" | "h"
  ];
  return Math.floor(Number(match[1]) * scale);
}
function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((row) => row.trim())
    .filter(Boolean);
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
  const tokenRef = required(flags, "token");
  const wallet = required(flags, "wallet");
  const live = flags.has("live");
  const loop = flags.has("loop");
  const intervalMs = duration(flags.get("interval"), 60 * 60_000);
  const minimumClaimRaw = raw(flags.get("min-claim-raw"), 1n);
  const reserveRaw = raw(flags.get("reserve-raw"), 0n);
  const minimumHolderRaw = raw(flags.get("min-holder-raw"), 1n);
  const excludeOwners = csv(flags.get("exclude"));
  const maxRecipientsPerTransaction = flags.get("max-per-tx")
    ? Number(flags.get("max-per-tx"))
    : undefined;
  if (live && !liveGate()) {
    throw new Error("--live requires SOLARD_ENABLE_LIVE_TRADES=1");
  }

  const slrd = createTraderSolard();
  try {
    const token = await m("token.resolve", async () => {
      try {
        return slrd.resolveToken(tokenRef);
      } catch {
        return await slrd.addToken(tokenRef);
      }
    });
    const source = slrd.resolveWallet(wallet).address;

    do {
      const bucket = Math.floor(Date.now() / intervalMs);
      const distributionId = `fairfun:${token.mint}:${bucket}`;
      await m("epoch", async () => {
        const existing = (
          await import("@solard/sdk")
        ).getHolderRewardDistributionState(slrd, distributionId);
        if (existing?.status === "complete") {
          return { distributionId, action: "already-complete" };
        }

        const claim = await slrd.resolveClaim(token, source);
        if (
          !existing &&
          claim.spendableByUserRaw < minimumClaimRaw + reserveRaw
        ) {
          return {
            distributionId,
            action: "hold",
            reason: "claim-below-threshold",
            estimatedSpendableRaw: claim.spendableByUserRaw,
            minimumClaimRaw,
            reserveRaw,
          };
        }

        if (!live) {
          const plan = await slrd.planHolderRewards({
            token: token.mint,
            wallet,
            claimFirst: true,
            reserveRaw,
            excludeOwners,
            minimumHolderRaw,
            maxRecipientsPerTransaction,
          });
          return {
            distributionId,
            action: "preview",
            rewardAmountRaw: plan.rewardAmountRaw,
            snapshotSlot: plan.snapshot.slot,
            holders: plan.allocations.length,
            batches: plan.transferPlan.batchCount,
          };
        }

        const state = await slrd.distributeHolderRewards({
          id: distributionId,
          token: token.mint,
          wallet,
          claimFirst: true,
          reserveRaw,
          excludeOwners,
          minimumHolderRaw,
          maxRecipientsPerTransaction,
          via: flags.get("sender") ?? "rpc",
        });
        return {
          distributionId,
          action: state.status,
          claimSignature: state.claimSignature,
          rewardAmountRaw: state.rewardAmountRaw,
          paid: state.allocations.filter((row) => row.paid).length,
          total: state.allocations.length,
          transactions: state.receipts.length,
        };
      });

      if (!loop) break;
      await m(
        "wait",
        () => new Promise((resolve) => setTimeout(resolve, intervalMs)),
      );
    } while (true);
  } finally {
    slrd.close();
  }
}

if (import.meta.main) {
  runFairfunRewardsAgent().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
