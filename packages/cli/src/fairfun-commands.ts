import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import type { Solard } from "@solard/sdk";

export type FairfunCliFlags = Map<string, string>;
type Emit = (value: string) => void;

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function flag(flags: FairfunCliFlags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function bool(flags: FairfunCliFlags, key: string): boolean {
  return flags.has(key) && flags.get(key) !== "false";
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveInteger(
  value: string | undefined,
  fallback?: number,
): number | undefined {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`Expected a positive integer, received ${value}`);
  return parsed;
}

function nonNegativeInteger(
  value: string | undefined,
  fallback?: number,
): number | undefined {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`Expected a non-negative integer, received ${value}`);
  return parsed;
}

function raw(value: string | undefined, name: string): bigint | undefined {
  if (value == null) return undefined;
  if (!/^\d+$/.test(value))
    throw new Error(`${name} must be a raw integer amount`);
  return BigInt(value);
}

async function ensureToken(slrd: Solard, ref: string) {
  try {
    return slrd.resolveToken(ref);
  } catch {
    return await slrd.addToken(new PublicKey(ref).toBase58());
  }
}

function requireLiveGate(): void {
  const enabled = [
    process.env.SOLARD_ENABLE_LIVE_TRADES,
    process.env.SLRD_ENABLE_LIVE_TRADES,
  ].some((value) => /^(1|true|yes)$/i.test(value?.trim() ?? ""));
  if (!enabled) {
    throw new Error(
      "Live Fairfun/reward transfers require SOLARD_ENABLE_LIVE_TRADES=1 as well as --live.",
    );
  }
}

function allocationsFile(
  path: string,
): Array<{ id?: string; recipient: string; amountRaw: bigint }> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as any).allocations)
      ? (parsed as any).allocations
      : null;
  if (!rows)
    throw new Error(
      "Transfer file must be a JSON array or { allocations: [...] }",
    );
  return rows.map((row: any, index: number) => {
    if (!row || typeof row !== "object")
      throw new Error(`Transfer allocation ${index + 1} must be an object`);
    const recipient = String(row.recipient ?? row.address ?? "").trim();
    const amountText = String(row.amountRaw ?? row.raw ?? "").trim();
    if (!recipient)
      throw new Error(`Transfer allocation ${index + 1} has no recipient`);
    if (!/^\d+$/.test(amountText) || BigInt(amountText) <= 0n)
      throw new Error(`Transfer allocation ${index + 1} has invalid amountRaw`);
    return {
      id: row.id == null ? undefined : String(row.id),
      recipient: new PublicKey(recipient).toBase58(),
      amountRaw: BigInt(amountText),
    };
  });
}

export async function handleFairfunCommand(args: {
  command: string | undefined;
  values: string[];
  flags: FairfunCliFlags;
  slrd: Solard;
  emit: Emit;
}): Promise<boolean> {
  const { command, values, flags, slrd, emit } = args;

  if (command === "holders") {
    const ref = values[0];
    if (!ref)
      throw new Error(
        "Usage: slrd holders <token|ca> [--exclude a,b] [--min-raw N] [--json]",
      );
    const token = await ensureToken(slrd, ref);
    const snapshot = await slrd.snapshotHolders(token.mint, {
      excludeOwners: csv(flag(flags, "exclude")),
      minimumRaw: raw(flag(flags, "min-raw"), "--min-raw"),
    });
    if (bool(flags, "json")) {
      emit(json(snapshot) + "\n");
      return true;
    }
    emit(
      `HOLDERS  ${snapshot.mint}\n` +
        `slot=${snapshot.slot} accounts=${snapshot.tokenAccounts} holders=${snapshot.holderCount} eligible=${snapshot.eligibleHolderCount}\n` +
        `eligibleRaw=${snapshot.eligibleTotalRaw} excludedRaw=${snapshot.excludedTotalRaw}\n\n` +
        `SHARE %    AMOUNT                    OWNER\n`,
    );
    for (const holder of snapshot.holders) {
      emit(
        `${holder.shareBps.toFixed(4).padStart(8)}  ${holder.amountUi.padStart(24)}  ${holder.owner}\n`,
      );
    }
    if (snapshot.excluded.length) {
      emit("\nEXCLUDED\n");
      for (const holder of snapshot.excluded)
        emit(
          `${holder.reason.padEnd(16)} ${holder.amountUi.padStart(20)}  ${holder.owner}\n`,
        );
    }
    return true;
  }

  if (command === "events") {
    const ref = values[0];
    if (!ref)
      throw new Error(
        "Usage: slrd events <token|ca> [--swaps-only|--transfers-only] [--jsonl]",
      );
    const token = await ensureToken(slrd, ref);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const swaps = !bool(flags, "transfers-only");
    const transfers = !bool(flags, "swaps-only");
    const subscription = await slrd.subscribeTokenEvents(token.mint, {
      swaps,
      transfers,
      commitment: bool(flags, "finalized") ? "finalized" : "confirmed",
      signal: controller.signal,
    });
    if (!bool(flags, "jsonl")) {
      emit(
        `EVENTS  ${subscription.mint}\n` +
          `addresses=${subscription.addresses.join(",")}\n` +
          `transfer-coverage=${subscription.transferCoverage}  Ctrl+C to stop\n\n`,
      );
    }
    try {
      for await (const event of subscription) {
        if (bool(flags, "jsonl")) {
          emit(
            JSON.stringify(event, (_, item) =>
              typeof item === "bigint" ? item.toString() : item,
            ) + "\n",
          );
          continue;
        }
        if (event.type === "swap") {
          emit(
            `${new Date(event.blockTimeMs ?? event.observedAtMs).toISOString()}  SWAP ${event.venue} ${event.side.toUpperCase()} ` +
              `${event.tokenAmountRaw} tokenRaw trader=${event.trader ?? "?"} sig=${event.signature}\n`,
          );
        } else {
          emit(
            `${new Date(event.blockTimeMs ?? event.observedAtMs).toISOString()}  TRANSFER ${event.amountRaw} ` +
              `${event.sourceOwner ?? event.sourceTokenAccount} -> ${event.destinationOwner ?? event.destinationTokenAccount} sig=${event.signature}\n`,
          );
        }
      }
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await subscription.close();
    }
    return true;
  }

  if (command === "transfer-many") {
    const wallet = flag(flags, "wallet");
    const file = flag(flags, "file");
    if (!wallet || !file)
      throw new Error(
        "Usage: slrd transfer-many --wallet <wallet> (--token <mint>|--sol) --file <allocations.json> [--live]",
      );
    const token = flag(flags, "token");
    const asset = bool(flags, "sol") ? "SOL" : token;
    if (!asset || (bool(flags, "sol") && token))
      throw new Error("Supply exactly one of --token <mint> or --sol");
    const allocations = allocationsFile(file);
    const common = {
      wallet,
      asset,
      allocations,
      priorityMicroLamports: nonNegativeInteger(
        flag(flags, "priority-micro-lamports"),
        0,
      ),
      maxRecipientsPerTransaction: positiveInteger(flag(flags, "max-per-tx")),
    };
    const plan = await slrd.planTransferMany(common);
    if (!bool(flags, "live")) {
      emit(
        json({
          live: false,
          payer: plan.payer,
          asset: plan.asset,
          totalRaw: plan.totalRaw,
          allocations: plan.allocationCount,
          batches: plan.batches.map((batch) => ({
            index: batch.index,
            recipients: batch.allocations.length,
            totalRaw: batch.totalRaw,
            serializedSize: batch.estimatedSerializedSize,
          })),
          packetLimit: plan.packetLimit,
        }) + "\n",
      );
      return true;
    }
    requireLiveGate();
    const result = await slrd.sendTransferMany({
      ...common,
      via: flag(flags, "sender") ?? "rpc",
      skipSimulation: bool(flags, "skip-simulation"),
      skipPreflight: bool(flags, "skip-preflight"),
    });
    emit(json(result) + "\n");
    return true;
  }

  if (command === "rewards" && values[0] === "status") {
    const id = values[1];
    if (!id) throw new Error("Usage: slrd rewards status <distribution-id>");
    const { getHolderRewardDistributionState } = await import("@solard/sdk");
    emit(json(getHolderRewardDistributionState(slrd, id)) + "\n");
    return true;
  }

  if (command === "rewards" && values[0] === "distribute") {
    const ref = values[1];
    const wallet = flag(flags, "wallet");
    if (!ref || !wallet)
      throw new Error(
        "Usage: slrd rewards distribute <token|ca> --wallet <beneficiary> [--claim-first | --amount-raw N] [--reward-mint <mint>] [--id <epoch>] [--live]",
      );
    const token = await ensureToken(slrd, ref);
    const common = {
      token: token.mint,
      wallet,
      rewardMint: flag(flags, "reward-mint"),
      amountRaw: raw(flag(flags, "amount-raw"), "--amount-raw"),
      claimFirst: bool(flags, "claim-first"),
      reserveRaw: raw(flag(flags, "reserve-raw"), "--reserve-raw") ?? 0n,
      excludeOwners: csv(flag(flags, "exclude")),
      minimumHolderRaw: raw(flag(flags, "min-holder-raw"), "--min-holder-raw"),
      maxRecipientsPerTransaction: positiveInteger(flag(flags, "max-per-tx")),
    };
    if (!bool(flags, "live")) {
      const plan = await slrd.planHolderRewards(common);
      emit(
        json({
          live: false,
          id: plan.id,
          tokenMint: plan.tokenMint,
          sourceWallet: plan.sourceWallet,
          claimFirst: plan.claimFirst,
          rewardAsset: plan.rewardAsset,
          rewardAmountRaw: plan.rewardAmountRaw,
          snapshotSlot: plan.snapshot.slot,
          holders: plan.snapshot.eligibleHolderCount,
          allocations: plan.allocations.length,
          undistributedRemainderRaw: plan.undistributedRemainderRaw,
          batches: plan.transferPlan.batches.map((batch) => ({
            index: batch.index,
            recipients: batch.allocations.length,
            totalRaw: batch.totalRaw,
            serializedSize: batch.estimatedSerializedSize,
          })),
        }) + "\n",
      );
      return true;
    }
    const id = flag(flags, "id");
    if (!id)
      throw new Error(
        "Live holder distribution requires --id <stable-epoch-id> so retries are idempotent.",
      );
    requireLiveGate();
    const state = await slrd.distributeHolderRewards({
      ...common,
      id,
      via: flag(flags, "sender") ?? "rpc",
      skipSimulation: bool(flags, "skip-simulation"),
      skipPreflight: bool(flags, "skip-preflight"),
    });
    emit(json(state) + "\n");
    return true;
  }

  return false;
}
