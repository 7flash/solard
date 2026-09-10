import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";

import type { QuoteAsset } from "../core/amounts.ts";
import type { TransactionAction, TransactionDraft } from "./types.ts";

export const SOLARD_V0_PACKET_LIMIT = 1232;

export type TransferManyAllocation = {
  recipient: string | PublicKey;
  amountRaw: bigint;
  /** Optional application identifier retained in the batch plan. */
  id?: string;
};

export type PackedTransferAllocation = {
  id: string;
  recipient: string;
  amountRaw: bigint;
  destinationTokenAccount: string | null;
  destinationExisted: boolean | null;
};

export type PackedTransferBatch = {
  index: number;
  allocations: PackedTransferAllocation[];
  totalRaw: bigint;
  estimatedSerializedSize: number;
  draft: TransactionDraft;
};

export type PackedTransferPlan = {
  version: 1;
  payer: string;
  asset: {
    kind: QuoteAsset["kind"];
    mint: string;
    tokenProgram: string;
    decimals: number;
  };
  totalRaw: bigint;
  allocationCount: number;
  batchCount: number;
  lookupTables: string[];
  packetLimit: number;
  batches: PackedTransferBatch[];
};

export type PackTransferManyOptions = {
  connection: Connection;
  payer: string | PublicKey;
  asset: QuoteAsset;
  allocations: TransferManyAllocation[];
  altAddresses?: Array<string | PublicKey>;
  cuLimit?: number;
  priorityMicroLamports?: number;
  maxRecipientsPerTransaction?: number;
};

function canonicalPubkey(value: string | PublicKey): PublicKey {
  return value instanceof PublicKey ? value : new PublicKey(value);
}

async function fetchLookupTables(
  connection: Connection,
  addresses: Array<string | PublicKey>,
): Promise<AddressLookupTableAccount[]> {
  const unique = [
    ...new Map(
      addresses.map((value) => {
        const key = canonicalPubkey(value);
        return [key.toBase58(), key] as const;
      }),
    ).values(),
  ];
  if (!unique.length) return [];
  const rows = await Promise.all(
    unique.map(
      async (address) =>
        (
          await connection.getAddressLookupTable(address, {
            commitment: "confirmed",
          })
        ).value,
    ),
  );
  return rows.filter((row): row is AddressLookupTableAccount => row != null);
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < rows.length; index += size)
    out.push(rows.slice(index, index + size));
  return out;
}

async function existingAccounts(
  connection: Connection,
  addresses: PublicKey[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunk(addresses, 100)) {
    const infos = await connection.getMultipleAccountsInfo(part, "confirmed");
    infos.forEach((info, index) => {
      if (info) out.add(part[index]!.toBase58());
    });
  }
  return out;
}

function sizeFailure(error: unknown): boolean {
  return (
    error instanceof RangeError ||
    (error instanceof Error &&
      /encoding overruns|transaction too large|too large|offset is outside/i.test(
        error.message,
      ))
  );
}

function estimateSerializedSize(args: {
  payer: PublicKey;
  blockhash: string;
  draft: TransactionDraft;
  lookupTables: AddressLookupTableAccount[];
}): number {
  const compute = [
    ComputeBudgetProgram.setComputeUnitLimit({
      units: args.draft.cuLimit ?? 600_000,
    }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: args.draft.cuPriceMicroLamports ?? 0,
    }),
  ];
  const message = new TransactionMessage({
    payerKey: args.payer,
    recentBlockhash: args.blockhash,
    instructions: [...compute, ...args.draft.instructions],
  }).compileToV0Message(args.lookupTables);
  return new VersionedTransaction(message).serialize().length;
}

function allocationInstructions(args: {
  payer: PublicKey;
  asset: QuoteAsset;
  recipient: PublicKey;
  amountRaw: bigint;
  destinationExists: boolean | null;
}): {
  instructions: TransactionInstruction[];
  action: TransactionAction;
  destinationTokenAccount: PublicKey | null;
} {
  if (args.asset.kind === "native-sol") {
    if (args.amountRaw > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("SOL transfer exceeds JS safe integer boundary");
    return {
      instructions: [
        SystemProgram.transfer({
          fromPubkey: args.payer,
          toPubkey: args.recipient,
          lamports: Number(args.amountRaw),
        }),
      ],
      action: {
        kind: "transfer-sol",
        recipient: args.recipient,
        meta: { raw: args.amountRaw.toString() },
      },
      destinationTokenAccount: null,
    };
  }

  const source = getAssociatedTokenAddressSync(
    args.asset.mint,
    args.payer,
    false,
    args.asset.tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const destination = getAssociatedTokenAddressSync(
    args.asset.mint,
    args.recipient,
    false,
    args.asset.tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const instructions: TransactionInstruction[] = [];
  if (!args.destinationExists) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        args.payer,
        destination,
        args.recipient,
        args.asset.mint,
        args.asset.tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }
  instructions.push(
    createTransferCheckedInstruction(
      source,
      args.asset.mint,
      destination,
      args.payer,
      args.amountRaw,
      args.asset.decimals,
      [],
      args.asset.tokenProgram,
    ),
  );
  return {
    instructions,
    action: {
      kind: "transfer-token",
      mint: args.asset.mint,
      recipient: args.recipient,
      meta: {
        raw: args.amountRaw.toString(),
        destinationTokenAccount: destination.toBase58(),
      },
    },
    destinationTokenAccount: destination,
  };
}

function draftFromEntries(args: {
  entries: Array<{
    allocation: PackedTransferAllocation;
    instructions: TransactionInstruction[];
    action: TransactionAction;
    destinationTokenAccount: PublicKey | null;
  }>;
  asset: QuoteAsset;
  cuLimit: number | undefined;
  priorityMicroLamports: number | undefined;
}): TransactionDraft {
  const trackedAccounts = args.entries.flatMap((entry) =>
    entry.destinationTokenAccount
      ? [
          {
            address: entry.destinationTokenAccount,
            kind: "token" as const,
            mint: args.asset.mint,
          },
        ]
      : [],
  );
  return {
    instructions: args.entries.flatMap((entry) => entry.instructions),
    signers: [],
    actions: args.entries.map((entry) => entry.action),
    trackedAccounts,
    cuLimit: args.cuLimit,
    cuPriceMicroLamports: args.priorityMicroLamports ?? 0,
  };
}

/**
 * Pack many independent transfers into the largest safe v0 transactions.
 *
 * Packing is based on actual serialized transaction size, including the same
 * compute-budget instructions used by Solard's normal assembler. Existing
 * destination ATAs are detected first so we do not pessimistically budget an
 * idempotent ATA-create instruction when it is unnecessary.
 */
export async function packTransferMany(
  options: PackTransferManyOptions,
): Promise<PackedTransferPlan> {
  if (!options.allocations.length)
    throw new Error("At least one transfer allocation is required");
  const payer = canonicalPubkey(options.payer);
  const maxRecipients = Math.max(
    1,
    Math.trunc(options.maxRecipientsPerTransaction ?? Number.MAX_SAFE_INTEGER),
  );

  const normalized = options.allocations.map((row, index) => {
    const recipient = canonicalPubkey(row.recipient);
    if (row.amountRaw <= 0n)
      throw new Error(`Transfer ${index + 1} amount must be positive`);
    return {
      id: row.id?.trim() || `allocation-${index + 1}`,
      recipient,
      amountRaw: row.amountRaw,
    };
  });
  const ids = new Set(normalized.map((row) => row.id));
  if (ids.size !== normalized.length)
    throw new Error("Transfer allocation ids must be unique");
  const recipients = new Set(normalized.map((row) => row.recipient.toBase58()));
  if (recipients.size !== normalized.length)
    throw new Error("Transfer recipients must be unique within one plan");

  const destinationExists = new Map<string, boolean>();
  if (options.asset.kind === "spl-token") {
    const destinations = normalized.map((row) =>
      getAssociatedTokenAddressSync(
        options.asset.mint,
        row.recipient,
        false,
        options.asset.tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    const existing = await existingAccounts(options.connection, destinations);
    destinations.forEach((destination) =>
      destinationExists.set(
        destination.toBase58(),
        existing.has(destination.toBase58()),
      ),
    );
  }

  const entries = normalized.map((row) => {
    const destinationTokenAccount =
      options.asset.kind === "spl-token"
        ? getAssociatedTokenAddressSync(
            options.asset.mint,
            row.recipient,
            false,
            options.asset.tokenProgram,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          )
        : null;
    const exists = destinationTokenAccount
      ? (destinationExists.get(destinationTokenAccount.toBase58()) ?? false)
      : null;
    const built = allocationInstructions({
      payer,
      asset: options.asset,
      recipient: row.recipient,
      amountRaw: row.amountRaw,
      destinationExists: exists,
    });
    return {
      allocation: {
        id: row.id,
        recipient: row.recipient.toBase58(),
        amountRaw: row.amountRaw,
        destinationTokenAccount:
          built.destinationTokenAccount?.toBase58() ?? null,
        destinationExisted: exists,
      } satisfies PackedTransferAllocation,
      instructions: built.instructions,
      action: built.action,
      destinationTokenAccount: built.destinationTokenAccount,
    };
  });

  const lookupTables = await fetchLookupTables(
    options.connection,
    options.altAddresses ?? [],
  );
  const latest = await options.connection.getLatestBlockhash("confirmed");
  const batches: PackedTransferBatch[] = [];
  let current: typeof entries = [];
  let currentSize = 0;

  const measure = (candidate: typeof entries): number => {
    const draft = draftFromEntries({
      entries: candidate,
      asset: options.asset,
      cuLimit: options.cuLimit,
      priorityMicroLamports: options.priorityMicroLamports,
    });
    return estimateSerializedSize({
      payer,
      blockhash: latest.blockhash,
      draft,
      lookupTables,
    });
  };
  const finish = () => {
    if (!current.length) return;
    const draft = draftFromEntries({
      entries: current,
      asset: options.asset,
      cuLimit: options.cuLimit,
      priorityMicroLamports: options.priorityMicroLamports,
    });
    batches.push({
      index: batches.length,
      allocations: current.map((row) => row.allocation),
      totalRaw: current.reduce(
        (sum, row) => sum + row.allocation.amountRaw,
        0n,
      ),
      estimatedSerializedSize: currentSize,
      draft,
    });
    current = [];
    currentSize = 0;
  };

  for (const entry of entries) {
    if (current.length >= maxRecipients) finish();
    const candidate = [...current, entry];
    let size: number;
    try {
      size = measure(candidate);
    } catch (error) {
      if (!sizeFailure(error)) throw error;
      size = SOLARD_V0_PACKET_LIMIT + 1;
    }
    if (size > SOLARD_V0_PACKET_LIMIT) {
      if (!current.length) {
        throw new Error(
          `One transfer to ${entry.allocation.recipient} cannot fit in a ${SOLARD_V0_PACKET_LIMIT}-byte v0 transaction`,
        );
      }
      finish();
      try {
        size = measure([entry]);
      } catch (error) {
        if (!sizeFailure(error)) throw error;
        size = SOLARD_V0_PACKET_LIMIT + 1;
      }
      if (size > SOLARD_V0_PACKET_LIMIT) {
        throw new Error(
          `One transfer to ${entry.allocation.recipient} cannot fit in a ${SOLARD_V0_PACKET_LIMIT}-byte v0 transaction`,
        );
      }
      current = [entry];
      currentSize = size;
    } else {
      current = candidate;
      currentSize = size;
    }
  }
  finish();

  return {
    version: 1,
    payer: payer.toBase58(),
    asset: {
      kind: options.asset.kind,
      mint: options.asset.mint.toBase58(),
      tokenProgram: options.asset.tokenProgram.toBase58(),
      decimals: options.asset.decimals,
    },
    totalRaw: normalized.reduce((sum, row) => sum + row.amountRaw, 0n),
    allocationCount: normalized.length,
    batchCount: batches.length,
    lookupTables: lookupTables.map((table) => table.key.toBase58()),
    packetLimit: SOLARD_V0_PACKET_LIMIT,
    batches,
  };
}
