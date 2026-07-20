import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { TransactionTooLargeError } from "../core/errors.ts";
import { measure } from "../core/log.ts";
import type { TransactionDraft, PlannedTransaction } from "./types.ts";
import type { BlockhashCache } from "../chain/blockhash.ts";

const m = measure("assemble");
const PACKET_LIMIT = 1232;

async function fetchLookupTables(
  connection: Connection,
  addresses: PublicKey[],
): Promise<AddressLookupTableAccount[]> {
  const rows = await Promise.all(
    addresses.map(
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

function uniqueSigners(payer: Keypair, signers: Keypair[]): Keypair[] {
  const seen = new Set<string>();
  const result: Keypair[] = [];
  for (const signer of [payer, ...signers]) {
    const key = signer.publicKey.toBase58();
    if (!seen.has(key)) {
      result.push(signer);
      seen.add(key);
    }
  }
  return result;
}

/** Account candidates that can be compressed through an ALT. Signers remain static. */
export function lookupCandidates(
  payer: PublicKey,
  draft: TransactionDraft,
): PublicKey[] {
  const signers = new Set([
    payer.toBase58(),
    ...draft.signers.map((signer) => signer.publicKey.toBase58()),
  ]);
  const seen = new Set<string>();
  const addresses: PublicKey[] = [];
  for (const ix of draft.instructions) {
    for (const meta of ix.keys) {
      const value = meta.pubkey.toBase58();
      if (meta.isSigner || signers.has(value) || seen.has(value)) continue;
      seen.add(value);
      addresses.push(meta.pubkey);
    }
    const program = ix.programId.toBase58();
    if (!signers.has(program) && !seen.has(program)) {
      seen.add(program);
      addresses.push(ix.programId);
    }
  }
  return addresses;
}

function isSizeFailure(error: unknown): boolean {
  return (
    (error instanceof RangeError &&
      error.message.includes("encoding overruns")) ||
    (error instanceof Error &&
      /encoding overruns|transaction too large|too large/i.test(error.message))
  );
}

export async function assembleTransaction(args: {
  connection: Connection;
  blockhash: BlockhashCache;
  payer: Keypair;
  draft: TransactionDraft;
  altAddresses: PublicKey[];
}): Promise<PlannedTransaction> {
  let plan: PlannedTransaction | undefined;
  let assemblyError: unknown;
  await m.measure(
    "v0",
    async () => {
      const latest = await args.blockhash.get(args.connection);
      const compute = [
        ComputeBudgetProgram.setComputeUnitLimit({
          units: args.draft.cuLimit ?? 600_000,
        }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: args.draft.cuPriceMicroLamports ?? 100_000,
        }),
      ];
      const draft = {
        ...args.draft,
        instructions: [...compute, ...args.draft.instructions],
      };
      // Load registered tables before signing. Previously Solard attempted to sign the
      // oversized uncompressed message first, which throws before ALT fallback runs.
      const tables = args.altAddresses.length
        ? await fetchLookupTables(args.connection, args.altAddresses)
        : [];
      const make = () => {
        const message = new TransactionMessage({
          payerKey: args.payer.publicKey,
          recentBlockhash: latest.blockhash,
          instructions: draft.instructions,
        }).compileToV0Message(tables);
        const tx = new VersionedTransaction(message);
        tx.sign(uniqueSigners(args.payer, args.draft.signers));
        return tx;
      };
      let transaction: VersionedTransaction;
      let size: number;
      try {
        transaction = make();
        size = transaction.serialize().length;
      } catch (error) {
        if (!isSizeFailure(error)) throw error;
        const candidates = lookupCandidates(
          args.payer.publicKey,
          args.draft,
        ).map((address) => address.toBase58());
        throw new TransactionTooLargeError(null, tables.length, candidates);
      }
      if (size > PACKET_LIMIT) {
        const candidates = lookupCandidates(
          args.payer.publicKey,
          args.draft,
        ).map((address) => address.toBase58());
        throw new TransactionTooLargeError(size, tables.length, candidates);
      }
      plan = {
        transaction,
        draft: args.draft,
        lookupTables: tables,
        serializedSize: size,
        payer: args.payer.publicKey,
        recentBlockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      };
      return {
        payer: args.payer.publicKey.toBase58(),
        instructions: draft.instructions.length,
        actions: args.draft.actions.length,
        lookupTables: tables.length,
        serializedSize: size,
      };
    },
    (error) => {
      assemblyError = error;
      return null;
    },
  );
  if (!plan) {
    if (assemblyError instanceof Error) throw assemblyError;
    throw new Error("Failed to assemble transaction plan");
  }
  return plan;
}
