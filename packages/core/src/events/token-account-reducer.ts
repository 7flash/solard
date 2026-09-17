import {
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";

import {
  physicalChainEventId,
  type CanonicalTokenBalanceEvent,
  type CanonicalTokenEventSource,
} from "./canonical.ts";
import {
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_ID,
} from "../venues/pump/constants.ts";

export type TokenAccountState = {
  address: string;
  mint: string;
  owner: string;
  amountRaw: bigint;
  exists: boolean;
};

export type TokenAccountReduction = {
  events: CanonicalTokenBalanceEvent[];
  accounts: ReadonlyMap<string, TokenAccountState>;
  ownerBalancesBefore: ReadonlyMap<string, bigint>;
  ownerBalancesAfter: ReadonlyMap<string, bigint>;
};

export class UnsupportedAccountingSemanticsError extends Error {
  readonly code = "UNSUPPORTED_ACCOUNTING_SEMANTICS";
  constructor(
    readonly instructionType: string,
    readonly instructionIndex: number | null,
    readonly innerInstructionIndex: number | null,
    detail?: string,
  ) {
    super(
      [
        "Unsupported token accounting semantics",
        instructionType || "unknown-instruction",
        `instruction=${instructionIndex == null ? "?" : instructionIndex}`,
        `inner=${innerInstructionIndex == null ? "outer" : innerInstructionIndex}`,
        detail,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
}

export { UnsupportedAccountingSemanticsError as UnsupportedTokenAccountingSemanticsError };
export type TokenAccountReducerResult = TokenAccountReduction;

type AccountMeta = {
  preOwner: string | null;
  postOwner: string | null;
  preRaw: bigint | null;
  postRaw: bigint | null;
};

type OrderedInstruction = {
  instruction: ParsedInstruction | PartiallyDecodedInstruction;
  instructionIndex: number;
  innerInstructionIndex: number | null;
};

const TOKEN_PROGRAMS = new Set([
  SPL_TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_ID.toBase58(),
]);

const HARMLESS_INSTRUCTION_TYPES = new Set([
  "approve",
  "approvechecked",
  "revoke",
  "freezeaccount",
  "thawaccount",
  "initializeimmutableowner",
  "initializemint",
  "initializemint2",
  "initializeaccount",
  "initializeaccount2",
  "initializeaccount3",
  "closeaccount",
  "setauthority",
  "getaccountdatasize",
  "amounttouiamount",
  "uiamounttoamount",
  "initializepermanentdelegate",
  "initializecloseauthority",
  "initializeinterestbearingmint",
  "updateinterestrate",
  "initializetransferhook",
  "updatetransferhook",
  "initializetransferfeeconfig",
  "settransferfee",
  "harvestwithheldtokenstomint",
  "enablecpi",
  "disablecpi",
  "enableconfidentialcredits",
  "disableconfidentialcredits",
  "enableconfidentialnonconfidentialcredits",
  "disableconfidentialnonconfidentialcredits",
]);

function keyText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (
    value &&
    typeof (value as { toBase58?: unknown }).toBase58 === "function"
  ) {
    return (value as { toBase58(): string }).toBase58();
  }
  return null;
}

function accountKeys(tx: ParsedTransactionWithMeta): string[] {
  const rows = (tx.transaction.message as any).accountKeys as any[];
  const keys = rows
    .map((row) => keyText(row?.pubkey ?? row))
    .filter((value): value is string => value != null);
  const hasResolvedLookupKeys = rows.some(
    (row) => row && typeof row === "object" && row.source === "lookupTable",
  );
  if (hasResolvedLookupKeys) return keys;
  const loaded = tx.meta?.loadedAddresses;
  if (!loaded) return keys;
  for (const value of [...loaded.writable, ...loaded.readonly]) {
    const address = keyText(value);
    if (address) keys.push(address);
  }
  return keys;
}

function metadataForMint(
  tx: ParsedTransactionWithMeta,
  mint: string,
): Map<string, AccountMeta> {
  const keys = accountKeys(tx);
  const out = new Map<string, AccountMeta>();
  const ensure = (address: string): AccountMeta => {
    const existing = out.get(address);
    if (existing) return existing;
    const created: AccountMeta = {
      preOwner: null,
      postOwner: null,
      preRaw: null,
      postRaw: null,
    };
    out.set(address, created);
    return created;
  };
  for (const row of tx.meta?.preTokenBalances ?? []) {
    if (row.mint !== mint) continue;
    const address = keys[row.accountIndex];
    if (!address) continue;
    const meta = ensure(address);
    meta.preOwner = typeof row.owner === "string" ? row.owner : null;
    meta.preRaw = BigInt(row.uiTokenAmount.amount);
  }
  for (const row of tx.meta?.postTokenBalances ?? []) {
    if (row.mint !== mint) continue;
    const address = keys[row.accountIndex];
    if (!address) continue;
    const meta = ensure(address);
    meta.postOwner = typeof row.owner === "string" ? row.owner : null;
    meta.postRaw = BigInt(row.uiTokenAmount.amount);
  }
  return out;
}

function orderedInstructions(
  tx: ParsedTransactionWithMeta,
): OrderedInstruction[] {
  const inner = new Map<
    number,
    Array<ParsedInstruction | PartiallyDecodedInstruction>
  >();
  for (const group of tx.meta?.innerInstructions ?? []) {
    inner.set(group.index, group.instructions);
  }
  const rows: OrderedInstruction[] = [];
  tx.transaction.message.instructions.forEach(
    (instruction, instructionIndex) => {
      rows.push({ instruction, instructionIndex, innerInstructionIndex: null });
      const nested = inner.get(instructionIndex) ?? [];
      nested.forEach((nestedInstruction, innerInstructionIndex) => {
        rows.push({
          instruction: nestedInstruction,
          instructionIndex,
          innerInstructionIndex,
        });
      });
    },
  );
  return rows;
}

function parsedInfo(
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

function stringField(
  info: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = info[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function rawAmount(info: Record<string, unknown>): bigint | null {
  const tokenAmount =
    info.tokenAmount && typeof info.tokenAmount === "object"
      ? (info.tokenAmount as Record<string, unknown>)
      : null;
  const raw = tokenAmount?.amount ?? info.amount;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0)
    return BigInt(raw);
  return null;
}

function rawFee(info: Record<string, unknown>): bigint {
  const parse = (value: unknown): bigint | null => {
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      return BigInt(value);
    return null;
  };
  const direct = parse(info.feeAmount);
  if (direct != null) return direct;
  if (info.feeAmount && typeof info.feeAmount === "object") {
    const nested = parse((info.feeAmount as Record<string, unknown>).amount);
    if (nested != null) return nested;
  }
  return 0n;
}

function instructionAccounts(
  instruction: ParsedInstruction | PartiallyDecodedInstruction,
): string[] {
  if ("accounts" in instruction && Array.isArray(instruction.accounts)) {
    return instruction.accounts.map((account) => account.toBase58());
  }
  const parsed = parsedInfo(instruction);
  if (!parsed) return [];
  const out: string[] = [];
  for (const value of Object.values(parsed.info)) {
    if (typeof value === "string") out.push(value);
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") out.push(item);
    }
  }
  return out;
}

function ownerBalances(
  accounts: Iterable<TokenAccountState>,
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const account of accounts) {
    if (!account.exists || account.amountRaw === 0n) continue;
    out.set(account.owner, (out.get(account.owner) ?? 0n) + account.amountRaw);
  }
  return out;
}

function cloneState(state: TokenAccountState): TokenAccountState {
  return { ...state };
}

function targetInstruction(args: {
  instruction: ParsedInstruction | PartiallyDecodedInstruction;
  info: Record<string, unknown> | null;
  mint: string;
  metadata: ReadonlyMap<string, AccountMeta>;
  accounts: ReadonlyMap<string, TokenAccountState>;
}): boolean {
  if (args.info && stringField(args.info, "mint") === args.mint) return true;
  for (const address of instructionAccounts(args.instruction)) {
    if (
      address === args.mint ||
      args.metadata.has(address) ||
      args.accounts.get(address)?.mint === args.mint
    )
      return true;
  }
  return false;
}

function requireExisting(
  accounts: Map<string, TokenAccountState>,
  address: string,
  row: OrderedInstruction,
  type: string,
): TokenAccountState {
  const state = accounts.get(address);
  if (!state?.exists) {
    throw new UnsupportedAccountingSemanticsError(
      type,
      row.instructionIndex,
      row.innerInstructionIndex,
      `account=${address} has no reconstructed pre-state`,
    );
  }
  return state;
}

function requireAmount(
  info: Record<string, unknown>,
  row: OrderedInstruction,
  type: string,
): bigint {
  const amount = rawAmount(info);
  if (amount == null) {
    throw new UnsupportedAccountingSemanticsError(
      type,
      row.instructionIndex,
      row.innerInstructionIndex,
      "raw amount is unavailable",
    );
  }
  return amount;
}

function requireSufficient(
  account: TokenAccountState,
  amount: bigint,
  row: OrderedInstruction,
  type: string,
): void {
  if (account.amountRaw < amount) {
    throw new UnsupportedAccountingSemanticsError(
      type,
      row.instructionIndex,
      row.innerInstructionIndex,
      `account=${account.address} reconstructed=${account.amountRaw} required=${amount}`,
    );
  }
}

export function reduceTokenAccountTransaction(args: {
  tx: ParsedTransactionWithMeta;
  signature: string;
  mint: string;
  decimals: number;
  confidence: "confirmed" | "finalized";
  source?: CanonicalTokenEventSource;
  strict?: boolean;
}): TokenAccountReduction {
  if (!args.tx.meta || args.tx.meta.err) {
    return {
      events: [],
      accounts: new Map(),
      ownerBalancesBefore: new Map(),
      ownerBalancesAfter: new Map(),
    };
  }

  const strict = args.strict ?? true;
  const metadata = metadataForMint(args.tx, args.mint);
  const accounts = new Map<string, TokenAccountState>();
  for (const [address, meta] of metadata) {
    if (meta.preRaw == null) continue;
    if (!meta.preOwner) {
      if (strict) {
        throw new UnsupportedAccountingSemanticsError(
          "pre-state",
          null,
          null,
          `account=${address} has no pre-owner`,
        );
      }
      continue;
    }
    accounts.set(address, {
      address,
      mint: args.mint,
      owner: meta.preOwner,
      amountRaw: meta.preRaw,
      exists: true,
    });
  }
  const ownerBalancesBefore = ownerBalances(accounts.values());
  const events: CanonicalTokenBalanceEvent[] = [];
  const source = args.source ?? "live-rpc";

  for (const row of orderedInstructions(args.tx)) {
    const programId = row.instruction.programId.toBase58();
    if (!TOKEN_PROGRAMS.has(programId)) continue;
    const parsed = parsedInfo(row.instruction);
    const relevant = targetInstruction({
      instruction: row.instruction,
      info: parsed?.info ?? null,
      mint: args.mint,
      metadata,
      accounts,
    });
    if (!parsed) {
      if (strict && relevant) {
        throw new UnsupportedAccountingSemanticsError(
          "partially-decoded-token-instruction",
          row.instructionIndex,
          row.innerInstructionIndex,
        );
      }
      continue;
    }

    const instructionType = parsed.type;
    const normalizedType = instructionType.toLowerCase();
    if (
      normalizedType === "getaccountdatasize" ||
      normalizedType === "amounttouiamount" ||
      normalizedType === "uiamounttoamount"
    )
      continue;
    const info = parsed.info;
    if (!relevant && stringField(info, "mint") !== args.mint) continue;
    const authority = stringField(info, "authority", "owner");
    const tokenAmount =
      info.tokenAmount && typeof info.tokenAmount === "object"
        ? (info.tokenAmount as Record<string, unknown>)
        : null;
    const decimals =
      typeof tokenAmount?.decimals === "number"
        ? tokenAmount.decimals
        : args.decimals;

    if (/^initializeaccount(?:2|3)?$/i.test(instructionType)) {
      const account = stringField(info, "account");
      const mint = stringField(info, "mint");
      const owner = stringField(info, "owner");
      if (mint !== args.mint || !account) continue;
      if (!owner) {
        if (strict)
          throw new UnsupportedAccountingSemanticsError(
            instructionType,
            row.instructionIndex,
            row.innerInstructionIndex,
            `account=${account} owner is unavailable`,
          );
        continue;
      }
      accounts.set(account, {
        address: account,
        mint: args.mint,
        owner,
        amountRaw: 0n,
        exists: true,
      });
      continue;
    }

    if (/^transfer(?:Checked|CheckedWithFee)?$/i.test(instructionType)) {
      const sourceAccount = stringField(info, "source");
      const destinationAccount = stringField(info, "destination");
      if (!sourceAccount || !destinationAccount) {
        if (strict && relevant)
          throw new UnsupportedAccountingSemanticsError(
            instructionType,
            row.instructionIndex,
            row.innerInstructionIndex,
            "source or destination is unavailable",
          );
        continue;
      }
      const sourceState = requireExisting(
        accounts,
        sourceAccount,
        row,
        instructionType,
      );
      const destinationState = requireExisting(
        accounts,
        destinationAccount,
        row,
        instructionType,
      );
      if (sourceState.mint !== args.mint || destinationState.mint !== args.mint)
        continue;
      const amountRaw = requireAmount(info, row, instructionType);
      const feeRaw = rawFee(info);
      if (feeRaw > amountRaw) {
        throw new UnsupportedAccountingSemanticsError(
          instructionType,
          row.instructionIndex,
          row.innerInstructionIndex,
          `fee=${feeRaw} exceeds amount=${amountRaw}`,
        );
      }
      requireSufficient(sourceState, amountRaw, row, instructionType);
      const destinationCredit = amountRaw - feeRaw;
      const event: CanonicalTokenBalanceEvent = {
        id: physicalChainEventId(
          args.signature,
          row.instructionIndex,
          row.innerInstructionIndex,
          0,
        ),
        type: "transfer",
        mint: args.mint,
        signature: args.signature,
        slot: args.tx.slot,
        observedAtMs: Date.now(),
        blockTimeMs:
          args.tx.blockTime == null ? null : args.tx.blockTime * 1_000,
        confidence: args.confidence,
        movement: "transfer",
        source,
        sourceTokenAccount: sourceAccount,
        destinationTokenAccount: destinationAccount,
        sourceOwner: sourceState.owner,
        destinationOwner: destinationState.owner,
        authority,
        amountRaw,
        feeRaw,
        decimals,
        instructionType,
        transactionIndex: null,
        instructionIndex: row.instructionIndex,
        innerInstructionIndex: row.innerInstructionIndex,
        effectOrdinal: 0,
      };
      sourceState.amountRaw -= amountRaw;
      destinationState.amountRaw += destinationCredit;
      events.push(event);
      continue;
    }

    if (/^mintTo(?:Checked)?$/i.test(instructionType)) {
      if (stringField(info, "mint") !== args.mint) continue;
      const destinationAccount = stringField(info, "account", "destination");
      if (!destinationAccount) {
        if (strict)
          throw new UnsupportedAccountingSemanticsError(
            instructionType,
            row.instructionIndex,
            row.innerInstructionIndex,
            "destination is unavailable",
          );
        continue;
      }
      const destinationState = requireExisting(
        accounts,
        destinationAccount,
        row,
        instructionType,
      );
      const amountRaw = requireAmount(info, row, instructionType);
      events.push({
        id: physicalChainEventId(
          args.signature,
          row.instructionIndex,
          row.innerInstructionIndex,
          0,
        ),
        type: "transfer",
        mint: args.mint,
        signature: args.signature,
        slot: args.tx.slot,
        observedAtMs: Date.now(),
        blockTimeMs:
          args.tx.blockTime == null ? null : args.tx.blockTime * 1_000,
        confidence: args.confidence,
        movement: "mint",
        source,
        sourceTokenAccount: null,
        destinationTokenAccount: destinationAccount,
        sourceOwner: null,
        destinationOwner: destinationState.owner,
        authority,
        amountRaw,
        feeRaw: 0n,
        decimals,
        instructionType,
        transactionIndex: null,
        instructionIndex: row.instructionIndex,
        innerInstructionIndex: row.innerInstructionIndex,
        effectOrdinal: 0,
      });
      destinationState.amountRaw += amountRaw;
      continue;
    }

    if (/^burn(?:Checked)?$/i.test(instructionType)) {
      if (stringField(info, "mint") !== args.mint) continue;
      const sourceAccount = stringField(info, "account", "source");
      if (!sourceAccount) {
        if (strict)
          throw new UnsupportedAccountingSemanticsError(
            instructionType,
            row.instructionIndex,
            row.innerInstructionIndex,
            "source is unavailable",
          );
        continue;
      }
      const sourceState = requireExisting(
        accounts,
        sourceAccount,
        row,
        instructionType,
      );
      const amountRaw = requireAmount(info, row, instructionType);
      requireSufficient(sourceState, amountRaw, row, instructionType);
      events.push({
        id: physicalChainEventId(
          args.signature,
          row.instructionIndex,
          row.innerInstructionIndex,
          0,
        ),
        type: "transfer",
        mint: args.mint,
        signature: args.signature,
        slot: args.tx.slot,
        observedAtMs: Date.now(),
        blockTimeMs:
          args.tx.blockTime == null ? null : args.tx.blockTime * 1_000,
        confidence: args.confidence,
        movement: "burn",
        source,
        sourceTokenAccount: sourceAccount,
        destinationTokenAccount: null,
        sourceOwner: sourceState.owner,
        destinationOwner: null,
        authority,
        amountRaw,
        feeRaw: 0n,
        decimals,
        instructionType,
        transactionIndex: null,
        instructionIndex: row.instructionIndex,
        innerInstructionIndex: row.innerInstructionIndex,
        effectOrdinal: 0,
      });
      sourceState.amountRaw -= amountRaw;
      continue;
    }

    if (/^setAuthority$/i.test(instructionType)) {
      const account = stringField(info, "account");
      const authorityType = String(info.authorityType ?? "").toLowerCase();
      if (
        !account ||
        !metadata.has(account) ||
        !authorityType.includes("owner")
      )
        continue;
      const state = requireExisting(accounts, account, row, instructionType);
      const nextOwner = stringField(info, "newAuthority");
      if (!nextOwner) {
        if (strict)
          throw new UnsupportedAccountingSemanticsError(
            instructionType,
            row.instructionIndex,
            row.innerInstructionIndex,
            `account=${account} new owner is unavailable`,
          );
        continue;
      }
      const previousOwner = state.owner;
      if (previousOwner !== nextOwner && state.amountRaw > 0n) {
        events.push({
          id: physicalChainEventId(
            args.signature,
            row.instructionIndex,
            row.innerInstructionIndex,
            0,
          ),
          type: "transfer",
          mint: args.mint,
          signature: args.signature,
          slot: args.tx.slot,
          observedAtMs: Date.now(),
          blockTimeMs:
            args.tx.blockTime == null ? null : args.tx.blockTime * 1_000,
          confidence: args.confidence,
          movement: "change-owner",
          source,
          sourceTokenAccount: account,
          destinationTokenAccount: account,
          sourceOwner: previousOwner,
          destinationOwner: nextOwner,
          authority,
          amountRaw: state.amountRaw,
          feeRaw: 0n,
          decimals,
          instructionType,
          transactionIndex: null,
          instructionIndex: row.instructionIndex,
          innerInstructionIndex: row.innerInstructionIndex,
          effectOrdinal: 0,
        });
      }
      state.owner = nextOwner;
      continue;
    }

    if (/^closeAccount$/i.test(instructionType)) {
      const account = stringField(info, "account");
      if (!account || !metadata.has(account)) continue;
      const state = requireExisting(accounts, account, row, instructionType);
      if (state.amountRaw !== 0n) {
        throw new UnsupportedAccountingSemanticsError(
          instructionType,
          row.instructionIndex,
          row.innerInstructionIndex,
          `account=${account} closes with reconstructed amount=${state.amountRaw}`,
        );
      }
      state.exists = false;
      continue;
    }

    if (/^syncNative$/i.test(instructionType)) {
      if (strict && relevant)
        throw new UnsupportedAccountingSemanticsError(
          instructionType,
          row.instructionIndex,
          row.innerInstructionIndex,
          "syncNative requires intermediate lamport state",
        );
      continue;
    }

    if (HARMLESS_INSTRUCTION_TYPES.has(normalizedType)) continue;

    if (strict && relevant) {
      throw new UnsupportedAccountingSemanticsError(
        instructionType,
        row.instructionIndex,
        row.innerInstructionIndex,
      );
    }
  }

  for (const [address, meta] of metadata) {
    const state = accounts.get(address);
    if (meta.postRaw == null) {
      if (state?.exists) {
        throw new UnsupportedAccountingSemanticsError(
          "post-state-reconciliation",
          null,
          null,
          `account=${address} still exists in reconstructed state but has no RPC post-state`,
        );
      }
      continue;
    }
    if (!state?.exists) {
      throw new UnsupportedAccountingSemanticsError(
        "post-state-reconciliation",
        null,
        null,
        `account=${address} is missing from reconstructed post-state`,
      );
    }
    if (state.amountRaw !== meta.postRaw) {
      throw new UnsupportedAccountingSemanticsError(
        "post-state-reconciliation",
        null,
        null,
        `account=${address} reconstructed=${state.amountRaw} rpc=${meta.postRaw}`,
      );
    }
    if (meta.postOwner && state.owner !== meta.postOwner) {
      throw new UnsupportedAccountingSemanticsError(
        "post-state-reconciliation",
        null,
        null,
        `account=${address} reconstructedOwner=${state.owner} rpcOwner=${meta.postOwner}`,
      );
    }
  }

  return {
    events,
    accounts: new Map(
      [...accounts].map(([address, state]) => [address, cloneState(state)]),
    ),
    ownerBalancesBefore,
    ownerBalancesAfter: ownerBalances(accounts.values()),
  };
}
