import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import type { Solard } from "@solard/core";

type FairfunEntitlementSnapshot = {
  recipients: Array<{ wallet: string; entitledRaw: string }>;
  totalEntitledRaw?: string;
  observedAtMs: number | null;
};

export type AccountingCliFlags = Map<string, string>;
type Emit = (value: string) => void;

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) =>
      typeof item === "bigint"
        ? item.toString()
        : item instanceof Map
          ? Object.fromEntries(item)
          : item,
    2,
  );
}

function flag(flags: AccountingCliFlags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function bool(flags: AccountingCliFlags, key: string): boolean {
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
      "Live reward transfers require SOLARD_ENABLE_LIVE_TRADES=1 as well as --live.",
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

function rewardSnapshotFile(path: string): FairfunEntitlementSnapshot {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as any;
  const rows = Array.isArray(parsed) ? parsed : parsed?.recipients;
  if (!Array.isArray(rows))
    throw new Error(
      "Reward snapshot must be a JSON array or { recipients: [...] }",
    );
  const recipients = rows.map((row: any, index: number) => {
    if (!row || typeof row !== "object")
      throw new Error(
        `Reward snapshot recipient ${index + 1} must be an object`,
      );
    const wallet = String(row.wallet ?? row.address ?? "").trim();
    const entitledRaw = String(
      row.entitledRaw ??
        row.accumulatedRewardRaw ??
        row.accumulatedRaw ??
        row.rewardRaw ??
        "",
    ).trim();
    if (!wallet)
      throw new Error(`Reward snapshot recipient ${index + 1} requires wallet`);
    if (!/^\d+$/.test(entitledRaw))
      throw new Error(
        `Reward snapshot recipient ${index + 1} entitledRaw must be a raw integer`,
      );
    return {
      wallet: new PublicKey(wallet).toBase58(),
      entitledRaw,
    };
  });
  const totalInput = Array.isArray(parsed)
    ? undefined
    : (parsed.totalEntitledRaw ?? parsed.totalRewardRaw ?? undefined);
  const totalEntitledRaw =
    totalInput == null ? undefined : String(totalInput).trim();
  if (totalEntitledRaw != null && !/^\d+$/.test(totalEntitledRaw))
    throw new Error("Reward snapshot totalEntitledRaw must be a raw integer");
  const observedAtMs =
    Array.isArray(parsed) || parsed.observedAtMs == null
      ? null
      : Number(parsed.observedAtMs);
  if (
    observedAtMs != null &&
    (!Number.isFinite(observedAtMs) || observedAtMs < 0)
  )
    throw new Error(
      "Reward snapshot observedAtMs must be a non-negative number",
    );
  return { recipients, totalEntitledRaw, observedAtMs };
}

export async function handleAccountingCommand(args: {
  command: string | undefined;
  values: string[];
  flags: AccountingCliFlags;
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

  if (command === "events" && values[0] === "history") {
    const ref = values[1];
    if (!ref)
      throw new Error(
        "Usage: slrd events history <token|ca> [--provider auto|solscan|rpc] [--from-slot N] [--to-slot N] [--slot-order] [--json|--jsonl]",
      );
    const token = await ensureToken(slrd, ref);
    const provider = flag(flags, "provider") ?? "auto";
    if (!new Set(["auto", "solscan", "rpc"]).has(provider))
      throw new Error("--provider must be auto, solscan, or rpc");
    const history = await slrd.events.history(token.mint, {
      provider: provider as "auto" | "solscan" | "rpc",
      fromSlot: nonNegativeInteger(flag(flags, "from-slot")),
      toSlot: nonNegativeInteger(flag(flags, "to-slot")),
      maxPages: positiveInteger(flag(flags, "max-pages")),
      exactOrdering: !bool(flags, "slot-order"),
      verifyCurrentBalances: !bool(flags, "no-verify"),
      commitment: bool(flags, "confirmed") ? "confirmed" : "finalized",
    });
    if (bool(flags, "json")) {
      emit(json({ coverage: history.coverage, events: history.events }) + "\n");
      return true;
    }
    if (bool(flags, "jsonl")) {
      for (const event of history.events) {
        emit(
          JSON.stringify(event, (_, item) =>
            typeof item === "bigint" ? item.toString() : item,
          ) + "\n",
        );
      }
      emit(JSON.stringify({ type: "coverage", ...history.coverage }) + "\n");
      return true;
    }
    emit(
      `EVENT HISTORY  ${history.mint}\n` +
        `provider=${history.coverage.provider} coverage=${history.coverage.status} transfer-coverage=${history.coverage.transferCoverage} from-creation=${history.coverage.fromCreation} authoritative=${history.coverage.authoritativeForBalanceReplay}\n` +
        `events=${history.events.length} slots=${history.coverage.firstEventSlot ?? "?"}..${history.coverage.lastEventSlot ?? "?"} ordering=${history.coverage.ordering}\n` +
        `balance-check=${history.coverage.balanceVerification.matches == null ? "not-checked" : history.coverage.balanceVerification.matches ? "match" : "MISMATCH"}\n\n`,
    );
    for (const event of history.events) {
      emit(
        `${new Date(event.blockTimeMs ?? event.observedAtMs).toISOString()}  ${event.movement.toUpperCase()} ${event.amountRaw} ` +
          `${event.sourceOwner ?? "MINT"} -> ${event.destinationOwner ?? "BURN"} slot=${event.slot} tx=${event.transactionIndex ?? "?"} sig=${event.signature}\n`,
      );
    }
    if (history.coverage.warnings.length) {
      emit("\nWARNINGS\n");
      for (const warning of history.coverage.warnings) emit(`- ${warning}\n`);
    }
    return true;
  }

  if (command === "events") {
    const ref = values[0];
    if (!ref)
      throw new Error(
        "Usage: slrd events <token|ca> [--all|--swaps|--transfers|--creates|--swaps-only|--transfers-only] [--jsonl]",
      );
    const token = await ensureToken(slrd, ref);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    const explicit =
      bool(flags, "all") ||
      bool(flags, "swaps") ||
      bool(flags, "transfers") ||
      bool(flags, "creates");
    let swaps = true;
    let transfers = true;
    let creates = false;
    if (bool(flags, "swaps-only")) {
      swaps = true;
      transfers = false;
      creates = false;
    } else if (bool(flags, "transfers-only")) {
      swaps = false;
      transfers = true;
      creates = false;
    } else if (explicit) {
      const all = bool(flags, "all");
      swaps = all || bool(flags, "swaps");
      transfers = all || bool(flags, "transfers");
      creates = all || bool(flags, "creates");
    }

    const subscription = await slrd.subscribeTokenEvents(token.mint, {
      swaps,
      transfers,
      creates,
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
              `${event.tokenAmountRaw} tokenRaw quote=${event.quoteAmountRaw ?? "?"} ${event.quoteMint} trader=${event.trader ?? "?"} sig=${event.signature}\n`,
          );
        } else if (event.type === "create") {
          emit(
            `${new Date(event.blockTimeMs ?? event.observedAtMs).toISOString()}  CREATE ` +
              `${event.symbol ?? "?"} ${event.name ?? "?"} creator=${event.creator ?? "?"} quote=${event.quoteMint} sig=${event.signature}\n`,
          );
        } else {
          emit(
            `${new Date(event.blockTimeMs ?? event.observedAtMs).toISOString()}  ${event.movement.toUpperCase()} ${event.amountRaw} ` +
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

  if (command === "transfer-many" && values[0] === "status") {
    const id = values[1];
    if (!id)
      throw new Error("Usage: slrd transfer-many status <distribution-id>");
    emit(json(slrd.getTransferManyStatus(id)) + "\n");
    return true;
  }

  if (command === "transfer-many" && values[0] === "resume") {
    const id = values[1];
    if (!id)
      throw new Error(
        "Usage: slrd transfer-many resume <distribution-id> [--sender rpc]",
      );
    requireLiveGate();
    const state = await slrd.resumeTransferMany(id, {
      via: flag(flags, "sender") ?? "rpc",
      priorityMicroLamports: nonNegativeInteger(
        flag(flags, "priority-micro-lamports"),
        0,
      ),
      maxRecipientsPerTransaction: positiveInteger(flag(flags, "max-per-tx")),
      skipSimulation: bool(flags, "skip-simulation"),
      skipPreflight: bool(flags, "skip-preflight"),
    });
    emit(json(state) + "\n");
    return true;
  }

  if (command === "transfer-many") {
    const wallet = flag(flags, "wallet");
    const file = flag(flags, "file");
    if (!wallet || !file)
      throw new Error(
        "Usage: slrd transfer-many --wallet <wallet> (--token <mint>|--sol) --file <allocations.json> [--id <stable-id> --live]",
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
          id: flag(flags, "id") ?? null,
          payer: plan.payer,
          asset: plan.asset,
          totalRaw: plan.totalRaw,
          allocations: plan.allocationCount,
          batches: plan.batches.map((batch) => ({
            index: batch.index,
            recipients: batch.allocations.length,
            allocationIds: batch.allocations.map((row) => row.id),
            totalRaw: batch.totalRaw,
            serializedSize: batch.estimatedSerializedSize,
          })),
          packetLimit: plan.packetLimit,
        }) + "\n",
      );
      return true;
    }
    const id = flag(flags, "id");
    if (!id) {
      throw new Error(
        "Live transfer-many requires --id <stable-distribution-id>. " +
          "This prevents ambiguous retries from double-paying recipients.",
      );
    }
    if (allocations.some((row) => !row.id?.trim())) {
      throw new Error(
        "Live durable transfer-many requires an explicit stable id on every allocation in the JSON file.",
      );
    }
    requireLiveGate();
    const state = await slrd.sendTransferMany({
      ...common,
      id,
      via: flag(flags, "sender") ?? "rpc",
      skipSimulation: bool(flags, "skip-simulation"),
      skipPreflight: bool(flags, "skip-preflight"),
    });
    emit(json(state) + "\n");
    return true;
  }

  if (command === "rewards" && values[0] === "history") {
    const ref = values[1];
    if (!ref)
      throw new Error(
        "Usage: slrd rewards history <token|ca> [--wallet <reward-recipient>] [--provider auto|solscan|rpc] [--json|--jsonl]",
      );
    for (const key of [
      "from-slot",
      "to-slot",
      "slot-order",
      "no-verify",
      "confirmed",
    ]) {
      if (flags.has(key)) {
        throw new Error(
          `--${key} is not supported by persistent replay; use slrd events history for bounded diagnostic history`,
        );
      }
    }
    const token = await ensureToken(slrd, ref);
    const provider = flag(flags, "provider") ?? "auto";
    if (!new Set(["auto", "solscan", "rpc"]).has(provider))
      throw new Error("--provider must be auto, solscan, or rpc");
    const history = await slrd.history.replay(token.mint, {
      recipient: flag(flags, "wallet"),
      provider: provider as "auto" | "solscan" | "rpc",
      maxPages: positiveInteger(flag(flags, "max-pages")),
      claimMaxPages: positiveInteger(flag(flags, "claim-max-pages")),
    });
    if (bool(flags, "json")) {
      emit(
        json({
          mint: history.mint,
          coverage: history.coverage,
          items: history.items,
        }) + "\n",
      );
      return true;
    }
    if (bool(flags, "jsonl")) {
      for (const item of history.items) emit(json(item) + "\n");
      emit(json({ type: "coverage", replay: history.coverage }) + "\n");
      return true;
    }
    const transfers = history.items.filter((item) => item.trx !== "claim");
    const claims = history.items.filter((item) => item.trx === "claim");
    emit(
      `REPLAY HISTORY  ${history.mint}\n` +
        `recipient=${"-"} authoritative=${history.coverage.complete} transfers=${transfers.length} claims=${claims.length} finalizedThroughSlot=${history.coverage.throughSlot}\n\n`,
    );
    for (const item of history.items) {
      const event = item.raw;
      if (event.type === "claim") {
        emit(
          `${new Date(event.blockTimeMs ?? event.observedAtMs).toISOString()}  CLAIM ${event.payout.amountRaw} ${event.payout.assetMint} attribution=${event.attribution} slot=${item.slot} tx=${item.transactionIndex ?? "?"} sig=${item.signature}\n`,
        );
      } else {
        emit(
          `${new Date(event.blockTimeMs ?? event.observedAtMs).toISOString()}  ${event.movement.toUpperCase()} ${event.amountRaw} ${event.sourceOwner ?? "MINT"} -> ${event.destinationOwner ?? "BURN"} slot=${item.slot} tx=${item.transactionIndex ?? "?"} sig=${item.signature}\n`,
        );
      }
    }
    if (history.coverage.warnings.length) {
      emit("\nWARNINGS\n");
      for (const warning of history.coverage.warnings) emit(`- ${warning}\n`);
    }
    return true;
  }

  if (command === "rewards" && values[0] === "status") {
    const ref = values[1];
    if (!ref) throw new Error("Usage: slrd rewards status <token|ca>");
    const token = await ensureToken(slrd, ref);
    emit(json(slrd.distributions.status(`fairfun:${token.mint}`)) + "\n");
    return true;
  }

  if (command === "rewards" && values[0] === "audit") {
    const ref = values[1];
    if (!ref)
      throw new Error(
        "Usage: slrd rewards audit <token|ca> [--holder <wallet>]",
      );
    const token = await ensureToken(slrd, ref);
    const state = slrd.distributions.status(`fairfun:${token.mint}`);
    const holder = flag(flags, "holder");
    emit(
      json(
        holder && state
          ? {
              ...state,
              recipients: state.recipients.filter(
                (row) => row.recipient === holder,
              ),
            }
          : state,
      ) + "\n",
    );
    return true;
  }

  if (command === "rewards" && values[0] === "stop") {
    const ref = values[1];
    if (!ref) throw new Error("Usage: slrd rewards stop <token|ca>");
    const token = await ensureToken(slrd, ref);
    throw new Error(
      `Distribution ${`fairfun:${token.mint}`} has no process-level stop state; stop the supervising process instead.`,
    );
  }

  if (command === "rewards" && values[0] === "distribute") {
    const ref = values[1];
    const wallet = flag(flags, "wallet");
    const snapshotPath = flag(flags, "snapshot");
    if (!ref || !wallet || !snapshotPath)
      throw new Error(
        "Usage: slrd rewards distribute <token|ca> --wallet <beneficiary> --snapshot <snapshot.json> [--reward-mint <mint>] [--reserve-raw N] [--live]",
      );
    const token = await ensureToken(slrd, ref);
    const snapshot = rewardSnapshotFile(snapshotPath);
    const common = {
      id: flag(flags, "id") ?? `fairfun:${token.mint}`,
      from: wallet,
      asset: flag(flags, "reward-mint") ?? token.quoteMint ?? "SOL",
      entitlements: snapshot.recipients.map((row) => ({
        recipient: row.wallet,
        entitledRaw: row.entitledRaw,
      })),
      reserveRaw: raw(flag(flags, "reserve-raw"), "--reserve-raw") ?? 0n,
      maxRecipientsPerTransaction: positiveInteger(flag(flags, "max-per-tx")),
    };
    if (!bool(flags, "live")) {
      const plan = await slrd.distributions.plan(common);
      emit(
        json({
          live: false,
          id: plan.id,
          sourceWallet: plan.sourceWallet,
          asset: plan.asset,
          totalEntitledRaw: plan.totalEntitledRaw,
          totalConfirmedPaidRaw: plan.totalConfirmedPaidRaw,
          totalOutstandingRaw: plan.totalOutstandingRaw,
          sourceBalanceRaw: plan.sourceBalanceRaw,
          availableRaw: plan.availableRaw,
          reserveRaw: plan.reserveRaw,
          outstanding: plan.outstanding,
          pending: plan.pending,
          nextBatch: plan.nextPayments.length
            ? { payments: plan.nextPayments }
            : null,
        }) + "\n",
      );
      return true;
    }
    requireLiveGate();
    const state = await slrd.distributions.execute({
      ...common,
      via: flag(flags, "sender") ?? "rpc",
      skipSimulation: bool(flags, "skip-simulation"),
      skipPreflight: bool(flags, "skip-preflight"),
    });
    emit(json(state) + "\n");
    return true;
  }

  return false;
}
