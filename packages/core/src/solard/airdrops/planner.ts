import { createHash } from "node:crypto";

import { PublicKey, type Connection } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getMint,
} from "@solana/spl-token";

import { getTerminalHoldersAction } from "../actions/terminal-holders.ts";
import type {
  AirdropDistributionMode,
  AirdropPlan,
  AirdropRecipient,
  AirdropRules,
} from "./types.ts";

type Input = Record<string, unknown>;
type HolderRow = Record<string, unknown>;

function bad(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function text(value: unknown, label: string, max = 256): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) bad(`${label} is required.`);
  return result.slice(0, max);
}

function publicKey(value: unknown, label: string): string {
  const result = text(value, label, 128);
  try {
    return new PublicKey(result).toBase58();
  } catch {
    return bad(`${label} must be a valid Solana public key.`);
  }
}

function decimal(value: unknown, label: string, allowZero = true): string {
  const result =
    typeof value === "string" ? value.trim() : String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(result)) {
    return bad(`${label} must be a non-negative decimal amount.`);
  }
  if (!allowZero && /^0(?:\.0+)?$/.test(result)) {
    return bad(`${label} must be greater than zero.`);
  }
  return result;
}

function integer(
  value: unknown,
  label: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) bad(`${label} must be a number.`);
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function decimalToUnits(
  value: string,
  decimals: number,
  label: string,
): bigint {
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    bad(`${label} has more than ${decimals} decimal places.`);
  }
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0")
  );
}

function unitsToDecimal(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function percentageMicros(value: string, label: string): bigint {
  const units = decimalToUnits(value, 6, label);
  if (units > 100_000_000n) bad(`${label} cannot exceed 100%.`);
  return units;
}

function holderOwner(row: HolderRow): string {
  return String(row.owner ?? row.tokenAccount ?? "").trim();
}

function holderAmountRaw(row: HolderRow): bigint {
  const value = row.amountRaw ?? row.amount ?? "0";
  try {
    return BigInt(String(value));
  } catch {
    return 0n;
  }
}

function holderRank(row: HolderRow, index: number): number {
  const value = Number(row.rank ?? index + 1);
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : index + 1;
}

function cleanExcluded(value: unknown): string[] {
  const rows = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  const output = new Set<string>();
  for (const item of rows) {
    const candidate = String(item ?? "").trim();
    if (!candidate) continue;
    output.add(publicKey(candidate, "excludedOwners item"));
  }
  return [...output].sort();
}

export function normalizeAirdropRules(body: Input): AirdropRules {
  const mode = String(body.mode ?? "fixed") as AirdropDistributionMode;
  if (!["fixed", "equal-total", "pro-rata"].includes(mode)) {
    bad("Unknown distribution mode.");
  }

  return {
    name: text(body.name ?? "Holder rewards", "name", 120),
    bankWallet: publicKey(body.bankWallet, "bankWallet"),
    sourceMint: publicKey(body.sourceMint, "sourceMint"),
    payoutMint: publicKey(body.payoutMint, "payoutMint"),
    holderLimit: integer(body.holderLimit, "holderLimit", 50, 1, 50),
    minBalanceUi: decimal(body.minBalanceUi ?? "0", "minBalanceUi"),
    minSharePct: decimal(body.minSharePct ?? "0", "minSharePct"),
    excludedOwners: cleanExcluded(body.excludedOwners),
    mode,
    fixedAmountUi: decimal(body.fixedAmountUi ?? "0", "fixedAmountUi"),
    totalAmountUi: decimal(body.totalAmountUi ?? "0", "totalAmountUi"),
    memo:
      typeof body.memo === "string" && body.memo.trim()
        ? body.memo.trim().slice(0, 200)
        : null,
    priorityMicroLamports: integer(
      body.priorityMicroLamports,
      "priorityMicroLamports",
      0,
      0,
      50_000_000,
    ),
  };
}

async function mintInfo(
  connection: Connection,
  address: string,
): Promise<{
  decimals: number;
  supply: bigint;
  programId: PublicKey;
  tokenProgram: "spl-token" | "token-2022";
}> {
  const mint = new PublicKey(address);
  const account = await connection.getAccountInfo(mint, "confirmed");
  if (!account) bad(`Mint account ${address} does not exist.`, 404);
  const tokenProgram = account.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? "token-2022"
    : account.owner.equals(TOKEN_PROGRAM_ID)
      ? "spl-token"
      : null;
  if (!tokenProgram) bad(`${address} is not an SPL Token mint.`);
  const programId =
    tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const value = await getMint(connection, mint, "confirmed", programId);
  return {
    decimals: value.decimals,
    supply: value.supply,
    programId,
    tokenProgram,
  };
}

function allocateEqual(total: bigint, count: number): bigint[] {
  if (count <= 0) return [];
  const divisor = BigInt(count);
  const base = total / divisor;
  const remainder = Number(total % divisor);
  return Array.from(
    { length: count },
    (_, index) => base + (index < remainder ? 1n : 0n),
  );
}

function allocateProRata(total: bigint, weights: bigint[]): bigint[] {
  const weightTotal = weights.reduce((sum, value) => sum + value, 0n);
  if (weightTotal <= 0n) bad("Eligible holder balances total zero.");
  const rows = weights.map((weight, index) => {
    const numerator = total * weight;
    return {
      index,
      units: numerator / weightTotal,
      remainder: numerator % weightTotal,
    };
  });
  let allocated = rows.reduce((sum, row) => sum + row.units, 0n);
  let left = total - allocated;
  rows.sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index;
    return a.remainder > b.remainder ? -1 : 1;
  });
  for (let index = 0; left > 0n; index += 1, left -= 1n) {
    rows[index % rows.length].units += 1n;
  }
  rows.sort((a, b) => a.index - b.index);
  return rows.map((row) => row.units);
}

function planHash(value: unknown): string {
  return `airdrop-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`;
}

export async function buildAirdropPlan(
  connection: Connection,
  rules: AirdropRules,
): Promise<AirdropPlan> {
  const [source, payout, holderPayload] = await Promise.all([
    mintInfo(connection, rules.sourceMint),
    mintInfo(connection, rules.payoutMint),
    getTerminalHoldersAction({
      mint: rules.sourceMint,
      limit: rules.holderLimit,
      refresh: true,
      source: "airdrops-planner",
    }),
  ]);

  const bank = rules.bankWallet;
  const excluded = new Set(rules.excludedOwners);
  const minimumBalance = decimalToUnits(
    rules.minBalanceUi,
    source.decimals,
    "minBalanceUi",
  );
  const minimumShareMicros = percentageMicros(rules.minSharePct, "minSharePct");
  const supply = source.supply;
  const holderRows = Array.isArray(holderPayload?.holders)
    ? (holderPayload.holders as HolderRow[])
    : [];

  const eligible = holderRows
    .map((row, index) => ({
      owner: holderOwner(row),
      rank: holderRank(row, index),
      sourceAmountRaw: holderAmountRaw(row),
    }))
    .filter((row) => {
      if (!row.owner || row.owner === bank || excluded.has(row.owner))
        return false;
      try {
        new PublicKey(row.owner);
      } catch {
        return false;
      }
      if (row.sourceAmountRaw < minimumBalance) return false;
      const shareMicros =
        supply > 0n ? (row.sourceAmountRaw * 100_000_000n) / supply : 0n;
      return shareMicros >= minimumShareMicros;
    });

  if (!eligible.length)
    bad("No holders match the current server-side filters.");

  let amounts: bigint[];
  if (rules.mode === "fixed") {
    const fixed = decimalToUnits(
      rules.fixedAmountUi,
      payout.decimals,
      "fixedAmountUi",
    );
    if (fixed <= 0n) bad("fixedAmountUi must be greater than zero.");
    amounts = eligible.map(() => fixed);
  } else {
    const total = decimalToUnits(
      rules.totalAmountUi,
      payout.decimals,
      "totalAmountUi",
    );
    if (total <= 0n) bad("totalAmountUi must be greater than zero.");
    amounts =
      rules.mode === "equal-total"
        ? allocateEqual(total, eligible.length)
        : allocateProRata(
            total,
            eligible.map((row) => row.sourceAmountRaw),
          );
  }

  if (amounts.some((value) => value <= 0n)) {
    bad(
      `The payout is too small for ${eligible.length} recipients at ${payout.decimals} decimals. ` +
        "Increase the total or reduce the holder set.",
    );
  }

  const recipients: AirdropRecipient[] = eligible.map((row, index) => {
    const shareMicros =
      supply > 0n ? (row.sourceAmountRaw * 100_000_000n) / supply : 0n;
    return {
      owner: row.owner,
      rank: row.rank,
      sourceAmountRaw: row.sourceAmountRaw.toString(),
      sourceBalanceUi: unitsToDecimal(row.sourceAmountRaw, source.decimals),
      sourceSharePct: unitsToDecimal(shareMicros, 6),
      amountUi: unitsToDecimal(amounts[index], payout.decimals),
      amountRaw: amounts[index].toString(),
    };
  });

  const totalAmountRaw = amounts.reduce((sum, value) => sum + value, 0n);
  const holderSnapshotAtMs = Number(
    (holderPayload as Record<string, unknown>)?.updatedAtMs ?? Date.now(),
  );
  const stable = {
    version: 3,
    rules,
    sourceDecimals: source.decimals,
    sourceSupplyRaw: source.supply.toString(),
    payoutDecimals: payout.decimals,
    payoutTokenProgram: payout.tokenProgram,
    recipients: recipients.map((row) => ({
      owner: row.owner,
      sourceAmountRaw: row.sourceAmountRaw,
      amountRaw: row.amountRaw,
    })),
  };

  return {
    schema: "solard.airdrop-plan",
    version: 3,
    planId: planHash(stable),
    name: rules.name,
    bankWallet: rules.bankWallet,
    sourceMint: rules.sourceMint,
    sourceDecimals: source.decimals,
    sourceSupplyRaw: source.supply.toString(),
    payoutMint: rules.payoutMint,
    payoutDecimals: payout.decimals,
    payoutTokenProgram: payout.tokenProgram,
    mode: rules.mode,
    memo: rules.memo,
    priorityMicroLamports: rules.priorityMicroLamports,
    holderSnapshotAtMs,
    recipientCount: recipients.length,
    totalAmountUi: unitsToDecimal(totalAmountRaw, payout.decimals),
    totalAmountRaw: totalAmountRaw.toString(),
    recipients,
    rules,
    requestedAt: new Date().toISOString(),
  };
}
