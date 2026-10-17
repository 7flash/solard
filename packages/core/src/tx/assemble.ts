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
  return rows.filter((row): row is AddressLookupTableAccount => row != null && row.isActive());
}

/** Extract existing ALT references from version-compatible parsed messages. Account
 * addresses in a parsed message are NOT themselves proof of ALT existence.
 * Raw RPC account keys in the same transaction are checked through the ALT
 * program, and only active tables with useful addresses are returned.
 */
export async function discoverRouteLookupTables(
  connection: Connection, draft: TransactionDraft, payer: PublicKey,
): Promise<PublicKey[]> {
  if (typeof connection.getSignaturesForAddress !== "function") return [];
  const covered = new Set(lookupCandidates(payer, draft).map(key => key.toBase58()));
  const pools = new Map<string, PublicKey>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    try { const key = new PublicKey(value); pools.set(value, key); } catch {}
  };
  for (const action of draft.actions) {
    const meta = action.meta ?? {};
    add(meta.pool); add(meta.targetPool); add(meta.fundingPool);
    for (const routeName of ["fundingRoute", "exitRoute"] as const) {
      const route = meta[routeName] as Record<string, unknown> | undefined;
      const legs = Array.isArray(route?.legs) ? route.legs : [];
      for (const leg of legs) {
        if (!leg || typeof leg !== "object") continue;
        const row = leg as Record<string, unknown>;
        add(row.pool);
        add((row.builtMeta as Record<string, unknown> | undefined)?.pool);
      }
    }
  }
  const candidates = new Map<string, PublicKey>();
  // Discover lookup table keys in v0/v1 parsed message keys using the loaded
  // addresses of a historical transaction only as candidates, then verify
  // each account's actual owner and ALT program deserialization on-chain.
  for (const pool of [...pools.values()].slice(0, 4)) {
    let signatures;
    try { signatures = await connection.getSignaturesForAddress(pool, { limit: 8 }, "confirmed"); }
    catch { continue; }
    for (const { signature } of signatures.slice(0, 8)) {
      try {
        // Raw _rpcRequest keeps the actual version 1 and does not invoke
        // web3.js' older getTransaction version-discriminator validator.
        const rpc = connection as Connection & {
          _rpcRequest?: (method: string, params: unknown[]) => Promise<{
            result?: { version?: unknown; transaction?: { message?: { addressTableLookups?:
              { accountKey: string }[] } } } }>;
        };
        if (!rpc._rpcRequest) continue;
        const result = (await rpc._rpcRequest("getTransaction", [signature, {
          encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 1,
        }])).result;
        if (!result || ![undefined, "legacy", 0, 1].includes(result.version as string | number | undefined))
          continue;
        for (const lookup of result.transaction?.message?.addressTableLookups ?? []) {
          const key = new PublicKey(lookup.accountKey);
          if (candidates.size < 32) candidates.set(key.toBase58(), key);
        }
      } catch { continue; }
    }
  }
  if (!candidates.size) return [];
  let tables: AddressLookupTableAccount[];
  try { tables = await fetchLookupTables(connection, [...candidates.values()]); }
  catch { return []; }
  return tables.map(table => ({ table,
    count: table.state.addresses.filter(key => covered.has(key.toBase58())).length,
  })).filter(row => row.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 4).map(row => row.table.key);
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
  payer: Keypair | PublicKey;
  unsigned?: boolean;
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
      const allAltAddresses = [
        ...new Map(
          [
            ...args.altAddresses,
            ...args.draft.actions.flatMap((action) =>
              (Array.isArray(action.meta?.lookupTableAddresses)
                ? action.meta.lookupTableAddresses
                : []
              ).map((address) => new PublicKey(String(address))),
            ),
          ].map((address) => [address.toBase58(), address]),
        ).values(),
      ];
      const payerKey = args.payer instanceof PublicKey ? args.payer : args.payer.publicKey;
      if (!args.unsigned && args.payer instanceof PublicKey)
        throw new Error("Public-only payer requires unsigned mode");
      let tables = allAltAddresses.length
        ? await fetchLookupTables(args.connection, allAltAddresses) : [];
      const make = (selected: AddressLookupTableAccount[]) => {
        const message = new TransactionMessage({ payerKey,
          recentBlockhash: latest.blockhash, instructions: draft.instructions,
        }).compileToV0Message(selected);
        const tx = new VersionedTransaction(message);
        return { tx, size: tx.serialize().length };
      };
      let transaction: VersionedTransaction | undefined;
      let size: number | null = null;
      try { const built = make(tables); transaction = built.tx; size = built.size; }
      catch (error) { if (!isSizeFailure(error)) throw error; }
      if (size == null || size > PACKET_LIMIT) {
        // History lookup errors must never replace a clear TOO_LARGE result.
        let found: PublicKey[] = [];
        try { found = await discoverRouteLookupTables(args.connection, args.draft, payerKey); }
        catch { /* retain packet-size error */ }
        const extra = found.filter(key => !tables.some(table => table.key.equals(key)));
        if (extra.length) {
          try {
            tables = [...tables, ...await fetchLookupTables(args.connection, extra)];
            const built = make(tables); transaction = built.tx; size = built.size;
          } catch (error) { if (!isSizeFailure(error)) throw error; }
        }
      }
      if (!transaction || size == null || size > PACKET_LIMIT) {
        throw new TransactionTooLargeError(size, tables.length,
          lookupCandidates(payerKey, args.draft).map(key => key.toBase58()));
      }
      if (!args.unsigned) transaction.sign(uniqueSigners(args.payer as Keypair, args.draft.signers));
      plan = {
        transaction,
        draft: args.draft,
        lookupTables: tables,
        serializedSize: size,
        payer: payerKey,
        recentBlockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      };
      return {
        payer: payerKey.toBase58(),
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
