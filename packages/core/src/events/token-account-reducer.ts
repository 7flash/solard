import {
  PublicKey,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";

import {
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_ID,
} from "../venues/pump/constants.ts";
import { chainEffectId } from "./canonical-events.ts";
import type {
  SolardTokenEventConfidence,
  SolardTokenTransferEvent,
  SolardTokenTransferSource,
} from "./token-events.ts";

export class UnsupportedTokenAccountingSemanticsError extends Error {
  readonly code = "UNSUPPORTED_ACCOUNTING_SEMANTICS" as const;
  constructor(
    readonly signature: string,
    readonly instructionType: string,
    readonly instructionIndex: number,
    readonly innerInstructionIndex: number | null,
  ) {
    super(
      `Unsupported balance-affecting token semantics signature=${signature} instruction=${instructionIndex}${innerInstructionIndex == null ? "" : `.${innerInstructionIndex}`} type=${instructionType || "unknown"}`,
    );
  }
}

type AccountState = {
  address: string;
  owner: string | null;
  amountRaw: bigint;
  decimals: number;
  exists: boolean;
};

type InstructionRow = {
  instruction: ParsedInstruction | PartiallyDecodedInstruction;
  instructionIndex: number;
  innerInstructionIndex: number | null;
};

export type TokenAccountReducerResult = {
  events: SolardTokenTransferEvent[];
  ownerBalancesBefore: Map<string, bigint>;
  ownerBalancesAfter: Map<string, bigint>;
};

function accountKeys(tx: ParsedTransactionWithMeta): string[] {
  return tx.transaction.message.accountKeys.map((row: { pubkey: PublicKey }) =>
    row.pubkey.toBase58(),
  );
}

function instructionRows(tx: ParsedTransactionWithMeta): InstructionRow[] {
  type InnerGroup = NonNullable<
    NonNullable<ParsedTransactionWithMeta["meta"]>["innerInstructions"]
  >[number];
  const innerByOuter = new Map<number, InnerGroup[]>();
  for (const group of tx.meta?.innerInstructions ?? []) {
    const current = innerByOuter.get(group.index) ?? [];
    current.push(group);
    innerByOuter.set(group.index, current);
  }
  const rows: InstructionRow[] = [];
  const outerInstructions = tx.transaction.message.instructions as Array<
    ParsedInstruction | PartiallyDecodedInstruction
  >;
  outerInstructions.forEach(
    (
      instruction: ParsedInstruction | PartiallyDecodedInstruction,
      instructionIndex: number,
    ) => {
      rows.push({ instruction, instructionIndex, innerInstructionIndex: null });
      const groups = innerByOuter.get(instructionIndex) ?? [];
      for (const group of groups) {
        const innerInstructions = group.instructions as Array<
          ParsedInstruction | PartiallyDecodedInstruction
        >;
        innerInstructions.forEach(
          (
            inner: ParsedInstruction | PartiallyDecodedInstruction,
            innerInstructionIndex: number,
          ) => {
            rows.push({
              instruction: inner,
              instructionIndex,
              innerInstructionIndex,
            });
          },
        );
      }
    },
  );
  return rows;
}

function parsedValue(
  instruction: ParsedInstruction | PartiallyDecodedInstruction,
): { type: string; info: Record<string, unknown> } | null {
  if (!("parsed" in instruction)) return null;
  const parsed = instruction.parsed as
    { type?: unknown; info?: Record<string, unknown> } | undefined;
  return {
    type: String(parsed?.type ?? ""),
    info: parsed?.info ?? {},
  };
}

function key(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof (value as { toBase58?: unknown }).toBase58 === "function"
  ) {
    return (value as { toBase58(): string }).toBase58();
  }
  return null;
}

function rawInteger(value: unknown): bigint | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  return null;
}

function rawAmount(info: Record<string, unknown>): bigint | null {
  const tokenAmount =
    info.tokenAmount && typeof info.tokenAmount === "object"
      ? (info.tokenAmount as Record<string, unknown>)
      : null;
  return rawInteger(tokenAmount?.amount ?? info.amount);
}

function rawFee(info: Record<string, unknown>): bigint {
  const direct = rawInteger(info.feeAmount);
  if (direct != null) return direct;
  if (info.feeAmount && typeof info.feeAmount === "object") {
    return rawInteger((info.feeAmount as Record<string, unknown>).amount) ?? 0n;
  }
  return 0n;
}

function decimals(info: Record<string, unknown>, fallback: number): number {
  const tokenAmount =
    info.tokenAmount && typeof info.tokenAmount === "object"
      ? (info.tokenAmount as Record<string, unknown>)
      : null;
  return typeof tokenAmount?.decimals === "number"
    ? tokenAmount.decimals
    : fallback;
}

function ownerBalances(states: Iterable<AccountState>): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const state of states) {
    if (!state.exists || !state.owner || state.amountRaw === 0n) continue;
    out.set(state.owner, (out.get(state.owner) ?? 0n) + state.amountRaw);
  }
  return out;
}

function seedStates(args: {
  tx: ParsedTransactionWithMeta;
  mint: string;
  fallbackDecimals: number;
}): {
  states: Map<string, AccountState>;
  preAddresses: Set<string>;
  postAddresses: Set<string>;
} {
  const keys = accountKeys(args.tx);
  const states = new Map<string, AccountState>();
  const preAddresses = new Set<string>();
  const postAddresses = new Set<string>();
  for (const row of args.tx.meta?.preTokenBalances ?? []) {
    if (row.mint !== args.mint) continue;
    const address = keys[row.accountIndex];
    if (!address) continue;
    preAddresses.add(address);
    states.set(address, {
      address,
      owner: typeof row.owner === "string" ? row.owner : null,
      amountRaw: BigInt(row.uiTokenAmount.amount),
      decimals: row.uiTokenAmount.decimals ?? args.fallbackDecimals,
      exists: true,
    });
  }
  for (const row of args.tx.meta?.postTokenBalances ?? []) {
    if (row.mint !== args.mint) continue;
    const address = keys[row.accountIndex];
    if (!address) continue;
    postAddresses.add(address);
    if (!states.has(address)) {
      states.set(address, {
        address,
        owner: typeof row.owner === "string" ? row.owner : null,
        amountRaw: 0n,
        decimals: row.uiTokenAmount.decimals ?? args.fallbackDecimals,
        exists: false,
      });
    }
  }
  return { states, preAddresses, postAddresses };
}

function touchesTarget(args: {
  info: Record<string, unknown>;
  states: Map<string, AccountState>;
  mint: string;
}): boolean {
  if (key(args.info.mint) === args.mint) return true;
  for (const field of [
    "account",
    "source",
    "destination",
    "tokenAccount",
    "wallet",
  ]) {
    const address = key(args.info[field]);
    if (address && args.states.has(address)) return true;
  }
  return false;
}

function ensureState(
  states: Map<string, AccountState>,
  address: string,
  fallbackDecimals: number,
  owner: string | null = null,
): AccountState {
  const existing = states.get(address);
  if (existing) return existing;
  const created: AccountState = {
    address,
    owner,
    amountRaw: 0n,
    decimals: fallbackDecimals,
    exists: false,
  };
  states.set(address, created);
  return created;
}

function eventBase(args: {
  signature: string;
  tx: ParsedTransactionWithMeta;
  mint: string;
  confidence: SolardTokenEventConfidence;
  source: SolardTokenTransferSource;
  instructionIndex: number;
  innerInstructionIndex: number | null;
  instructionType: string;
}) {
  return {
    id: chainEffectId(args),
    type: "transfer" as const,
    mint: args.mint,
    signature: args.signature,
    slot: args.tx.slot,
    observedAtMs: Date.now(),
    blockTimeMs: args.tx.blockTime == null ? null : args.tx.blockTime * 1_000,
    confidence: args.confidence,
    source: args.source,
    instructionType: args.instructionType,
    transactionIndex: null,
    instructionIndex: args.instructionIndex,
    innerInstructionIndex: args.innerInstructionIndex,
  };
}

function unsupported(args: {
  strict: boolean;
  signature: string;
  instructionType: string;
  instructionIndex: number;
  innerInstructionIndex: number | null;
}): never | void {
  if (!args.strict) return;
  throw new UnsupportedTokenAccountingSemanticsError(
    args.signature,
    args.instructionType,
    args.instructionIndex,
    args.innerInstructionIndex,
  );
}

function reconcilePostState(args: {
  tx: ParsedTransactionWithMeta;
  mint: string;
  states: Map<string, AccountState>;
  preAddresses: Set<string>;
  postAddresses: Set<string>;
}): void {
  const keys = accountKeys(args.tx);
  for (const row of args.tx.meta?.postTokenBalances ?? []) {
    if (row.mint !== args.mint) continue;
    const address = keys[row.accountIndex];
    if (!address) continue;
    const state = args.states.get(address);
    const expectedRaw = BigInt(row.uiTokenAmount.amount);
    const expectedOwner = typeof row.owner === "string" ? row.owner : null;
    if (
      !state ||
      !state.exists ||
      state.amountRaw !== expectedRaw ||
      (expectedOwner != null && state.owner !== expectedOwner)
    ) {
      throw new Error(
        `TOKEN_ACCOUNT_POST_STATE_MISMATCH account=${address} expected=${expectedRaw.toString()}:${expectedOwner ?? "?"} actual=${state?.amountRaw.toString() ?? "missing"}:${state?.owner ?? "?"}`,
      );
    }
  }
  for (const address of args.preAddresses) {
    if (args.postAddresses.has(address)) continue;
    const state = args.states.get(address);
    if (state?.exists) {
      throw new Error(
        `TOKEN_ACCOUNT_POST_STATE_MISMATCH account=${address} expected=closed actual=${state.amountRaw.toString()}`,
      );
    }
  }
}

const NON_BALANCE_INSTRUCTIONS = new Set([
  "approve",
  "approveChecked",
  "revoke",
  "freezeAccount",
  "thawAccount",
  "initializeMint",
  "initializeMint2",
  "initializeImmutableOwner",
  "initializeMultisig",
  "initializeMultisig2",
  "setAuthority",
]);

export function reduceTokenAccountTransaction(args: {
  tx: ParsedTransactionWithMeta;
  signature: string;
  mint: string;
  decimals: number;
  confidence: SolardTokenEventConfidence;
  source?: SolardTokenTransferSource;
  strict?: boolean;
}): TokenAccountReducerResult {
  if (!args.tx.meta || args.tx.meta.err) {
    return {
      events: [],
      ownerBalancesBefore: new Map(),
      ownerBalancesAfter: new Map(),
    };
  }
  const strict = args.strict !== false;
  const source = args.source ?? "live-rpc";
  const seeded = seedStates({
    tx: args.tx,
    mint: args.mint,
    fallbackDecimals: args.decimals,
  });
  const beforeStates = [...seeded.states.values()].map((state) => ({
    ...state,
  }));
  const events: SolardTokenTransferEvent[] = [];
  const tokenPrograms = new Set([
    SPL_TOKEN_PROGRAM_ID.toBase58(),
    TOKEN_2022_ID.toBase58(),
  ]);

  for (const row of instructionRows(args.tx)) {
    const programId = row.instruction.programId.toBase58();
    if (!tokenPrograms.has(programId)) continue;
    const parsed = parsedValue(row.instruction);
    if (!parsed) {
      unsupported({
        strict,
        signature: args.signature,
        instructionType: "partially-decoded-token-instruction",
        instructionIndex: row.instructionIndex,
        innerInstructionIndex: row.innerInstructionIndex,
      });
      continue;
    }
    const { type: instructionType, info } = parsed;
    const directMint = key(info.mint);
    const authority = key(info.authority) ?? key(info.owner);
    const base = eventBase({
      signature: args.signature,
      tx: args.tx,
      mint: args.mint,
      confidence: args.confidence,
      source,
      instructionIndex: row.instructionIndex,
      innerInstructionIndex: row.innerInstructionIndex,
      instructionType,
    });

    if (/^initializeAccount(?:2|3)?$/i.test(instructionType)) {
      const address = key(info.account);
      const owner = key(info.owner);
      const mint = directMint;
      if (!address || mint !== args.mint) continue;
      const state = ensureState(seeded.states, address, args.decimals, owner);
      state.owner = owner ?? state.owner;
      state.exists = true;
      continue;
    }

    if (/^transfer(?:Checked|CheckedWithFee)?$/i.test(instructionType)) {
      const sourceAddress = key(info.source);
      const destinationAddress = key(info.destination);
      if (!sourceAddress || !destinationAddress) continue;
      const sourceState = seeded.states.get(sourceAddress);
      const destinationState = seeded.states.get(destinationAddress);
      const inferredMint =
        directMint ?? (sourceState || destinationState ? args.mint : null);
      if (inferredMint !== args.mint) continue;
      const amountRaw = rawAmount(info);
      if (amountRaw == null || amountRaw <= 0n) continue;
      const feeRaw = rawFee(info);
      const sourceAccount = ensureState(
        seeded.states,
        sourceAddress,
        args.decimals,
      );
      const destinationAccount = ensureState(
        seeded.states,
        destinationAddress,
        args.decimals,
      );
      if (!sourceAccount.exists || sourceAccount.amountRaw < amountRaw) {
        throw new Error(
          `TOKEN_ACCOUNT_REPLAY_UNDERFLOW account=${sourceAddress} signature=${args.signature}`,
        );
      }
      const credited = amountRaw > feeRaw ? amountRaw - feeRaw : 0n;
      sourceAccount.amountRaw -= amountRaw;
      destinationAccount.exists = true;
      destinationAccount.amountRaw += credited;
      events.push({
        ...base,
        movement: "transfer",
        sourceTokenAccount: sourceAddress,
        destinationTokenAccount: destinationAddress,
        sourceOwner: sourceAccount.owner,
        destinationOwner: destinationAccount.owner,
        authority,
        amountRaw,
        feeRaw,
        decimals: decimals(info, sourceAccount.decimals),
      });
      continue;
    }

    if (/^mintTo(?:Checked)?$/i.test(instructionType)) {
      const destinationAddress = key(info.account) ?? key(info.destination);
      if (!destinationAddress || directMint !== args.mint) continue;
      const amountRaw = rawAmount(info);
      if (amountRaw == null || amountRaw <= 0n) continue;
      const destinationAccount = ensureState(
        seeded.states,
        destinationAddress,
        args.decimals,
      );
      destinationAccount.exists = true;
      destinationAccount.amountRaw += amountRaw;
      events.push({
        ...base,
        movement: "mint",
        sourceTokenAccount: null,
        destinationTokenAccount: destinationAddress,
        sourceOwner: null,
        destinationOwner: destinationAccount.owner,
        authority,
        amountRaw,
        feeRaw: 0n,
        decimals: decimals(info, destinationAccount.decimals),
      });
      continue;
    }

    if (/^burn(?:Checked)?$/i.test(instructionType)) {
      const sourceAddress = key(info.account) ?? key(info.source);
      if (!sourceAddress || directMint !== args.mint) continue;
      const amountRaw = rawAmount(info);
      if (amountRaw == null || amountRaw <= 0n) continue;
      const sourceAccount = ensureState(
        seeded.states,
        sourceAddress,
        args.decimals,
      );
      if (!sourceAccount.exists || sourceAccount.amountRaw < amountRaw) {
        throw new Error(
          `TOKEN_ACCOUNT_REPLAY_UNDERFLOW account=${sourceAddress} signature=${args.signature}`,
        );
      }
      sourceAccount.amountRaw -= amountRaw;
      events.push({
        ...base,
        movement: "burn",
        sourceTokenAccount: sourceAddress,
        destinationTokenAccount: null,
        sourceOwner: sourceAccount.owner,
        destinationOwner: null,
        authority,
        amountRaw,
        feeRaw: 0n,
        decimals: decimals(info, sourceAccount.decimals),
      });
      continue;
    }

    if (/^setAuthority$/i.test(instructionType)) {
      const address = key(info.account);
      const authorityType = String(info.authorityType ?? "").toLowerCase();
      if (!address || !authorityType.includes("owner")) {
        if (touchesTarget({ info, states: seeded.states, mint: args.mint })) {
          continue;
        }
        continue;
      }
      const state = seeded.states.get(address);
      if (!state) continue;
      const nextOwner = key(info.newAuthority);
      if (!nextOwner || nextOwner === state.owner) continue;
      const previousOwner = state.owner;
      state.owner = nextOwner;
      if (state.amountRaw > 0n) {
        events.push({
          ...base,
          movement: "change-owner",
          sourceTokenAccount: address,
          destinationTokenAccount: address,
          sourceOwner: previousOwner,
          destinationOwner: nextOwner,
          authority,
          amountRaw: state.amountRaw,
          feeRaw: 0n,
          decimals: state.decimals,
        });
      }
      continue;
    }

    if (/^closeAccount$/i.test(instructionType)) {
      const address = key(info.account);
      if (!address) continue;
      const state = seeded.states.get(address);
      if (!state) continue;
      if (state.amountRaw !== 0n) {
        throw new Error(
          `TOKEN_ACCOUNT_CLOSE_NONZERO account=${address} signature=${args.signature}`,
        );
      }
      state.exists = false;
      continue;
    }

    if (NON_BALANCE_INSTRUCTIONS.has(instructionType)) continue;
    if (touchesTarget({ info, states: seeded.states, mint: args.mint })) {
      unsupported({
        strict,
        signature: args.signature,
        instructionType,
        instructionIndex: row.instructionIndex,
        innerInstructionIndex: row.innerInstructionIndex,
      });
    }
  }

  reconcilePostState({
    tx: args.tx,
    mint: args.mint,
    states: seeded.states,
    preAddresses: seeded.preAddresses,
    postAddresses: seeded.postAddresses,
  });

  return {
    events,
    ownerBalancesBefore: ownerBalances(beforeStates),
    ownerBalancesAfter: ownerBalances(seeded.states.values()),
  };
}
