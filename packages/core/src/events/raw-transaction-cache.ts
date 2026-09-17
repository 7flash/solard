import { Buffer } from "buffer";
import {
  PublicKey,
  type Commitment,
  type Connection,
  type ParsedTransactionWithMeta,
  type SignaturesForAddressOptions,
} from "@solana/web3.js";

import type { SolardDatabase } from "../db/schema.ts";

const HEAD_SETTING = "history:raw-cache:finalized-head";
const connectionDatabases = new WeakMap<object, SolardDatabase>();

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function encode(value: unknown): JsonValue {
  if (
    value == null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return value as JsonValue;
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof PublicKey) {
    const publicKey = value as { toBase58(): string };
    return { $publicKey: publicKey.toBase58() };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return { $bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === "object") {
    const base58 = (value as { toBase58?: unknown }).toBase58;
    if (typeof base58 === "function")
      return { $publicKey: (value as { toBase58(): string }).toBase58() };
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      out[key] = encode(item);
    return out;
  }
  throw new Error(`Unsupported raw transaction cache value: ${typeof value}`);
}

function decode(value: JsonValue): unknown {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  if ("$publicKey" in value) return new PublicKey(String(value.$publicKey));
  if ("$bytes" in value) return Buffer.from(String(value.$bytes), "base64");
  if ("$bigint" in value) return BigInt(String(value.$bigint));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = decode(item);
  return out;
}

export function serializeParsedTransaction(
  tx: ParsedTransactionWithMeta,
): string {
  return JSON.stringify(encode(tx));
}

export function deserializeParsedTransaction(
  value: string,
): ParsedTransactionWithMeta {
  return decode(JSON.parse(value) as JsonValue) as ParsedTransactionWithMeta;
}

export function cacheParsedTransaction(args: {
  database: SolardDatabase;
  signature: string;
  transaction: ParsedTransactionWithMeta;
  confidence: "confirmed" | "finalized";
}): void {
  const now = Date.now();
  args.database.rawTransactions.upsert(
    {
      signature: args.signature,
      slot: args.transaction.slot,
      blockTimeMs:
        args.transaction.blockTime == null
          ? null
          : args.transaction.blockTime * 1_000,
      confidence: args.confidence,
      transactionJson: serializeParsedTransaction(args.transaction),
      fetchedAtMs: now,
      updatedAtMs: now,
    },
    {
      on: "signature",
      merge: (table: any) => ({
        slot: table.excluded("slot"),
        blockTimeMs: table.excluded("blockTimeMs"),
        confidence: table.excluded("confidence"),
        transactionJson: table.excluded("transactionJson"),
        fetchedAtMs: table.excluded("fetchedAtMs"),
        updatedAtMs: table.max("updatedAtMs", 0),
      }),
    },
  );
}

export function cachedParsedTransaction(
  database: SolardDatabase,
  signature: string,
): ParsedTransactionWithMeta | null {
  const row = database.rawTransactions.select().where({ signature }).first() as
    { transactionJson?: string } | undefined;
  return row?.transactionJson
    ? deserializeParsedTransaction(row.transactionJson)
    : null;
}

function saveHead(database: SolardDatabase, slot: number): void {
  const now = Date.now();
  const row = database.settings
    .select()
    .where({ key: HEAD_SETTING })
    .first() as { value?: string } | undefined;
  const previous = Number(row?.value ?? 0);
  const next = Math.max(Number.isFinite(previous) ? previous : 0, slot);
  if (row)
    database.settings
      .update({ value: String(next), updatedAtMs: now })
      .where({ key: HEAD_SETTING })
      .exec();
  else
    database.settings.insert({
      key: HEAD_SETTING,
      value: String(next),
      updatedAtMs: now,
    });
}

function cachedHead(database: SolardDatabase): number | null {
  const row = database.settings
    .select()
    .where({ key: HEAD_SETTING })
    .first() as { value?: string } | undefined;
  const value = Number(row?.value);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function scopeText(address: PublicKey): string {
  return address.toBase58();
}

function cacheDiscovery(args: {
  database: SolardDatabase;
  scope: string;
  rows: readonly any[];
}): void {
  const now = Date.now();
  args.database.transaction(() => {
    for (const row of args.rows) {
      args.database.historyDiscovery.upsert(
        {
          discoveryKey: `${args.scope}:${row.signature}`,
          scope: args.scope,
          signature: row.signature,
          slot: row.slot,
          errJson: row.err == null ? null : JSON.stringify(row.err),
          blockTimeMs: row.blockTime == null ? null : row.blockTime * 1_000,
          confirmationStatus: row.confirmationStatus ?? null,
          discoveredAtMs: now,
        },
        {
          on: "discoveryKey",
          merge: (table: any) => ({
            slot: table.excluded("slot"),
            errJson: table.excluded("errJson"),
            blockTimeMs: table.excluded("blockTimeMs"),
            confirmationStatus: table.excluded("confirmationStatus"),
            discoveredAtMs: table.max("discoveredAtMs", 0),
          }),
        },
      );
    }
  });
}

export type CachedTokenAccountIncarnation = {
  slot: number;
  signature: string;
};

export type CachedHistoricalTokenAccount = {
  address: string;
  initializedAtSlot: number | null;
  initializedBySignature: string | null;
  incarnations?: CachedTokenAccountIncarnation[];
};

function normalizeIncarnations(
  account: Pick<
    CachedHistoricalTokenAccount,
    "initializedAtSlot" | "initializedBySignature"
  > & { incarnations?: readonly CachedTokenAccountIncarnation[] },
): CachedTokenAccountIncarnation[] {
  const bySignature = new Map<string, CachedTokenAccountIncarnation>();
  for (const row of account.incarnations ?? []) {
    if (!Number.isInteger(row.slot) || row.slot < 0 || !row.signature) continue;
    const current = bySignature.get(row.signature);
    if (!current || row.slot < current.slot) {
      bySignature.set(row.signature, {
        slot: row.slot,
        signature: row.signature,
      });
    }
  }
  if (account.initializedAtSlot != null && account.initializedBySignature) {
    const current = bySignature.get(account.initializedBySignature);
    if (!current || account.initializedAtSlot < current.slot) {
      bySignature.set(account.initializedBySignature, {
        slot: account.initializedAtSlot,
        signature: account.initializedBySignature,
      });
    }
  }
  return [...bySignature.values()].sort(
    (a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature),
  );
}

function parseIncarnations(
  value: string | null | undefined,
): CachedTokenAccountIncarnation[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const slot = (row as { slot?: unknown }).slot;
      const signature = (row as { signature?: unknown }).signature;
      return typeof slot === "number" &&
        Number.isInteger(slot) &&
        slot >= 0 &&
        typeof signature === "string" &&
        signature
        ? [{ slot, signature }]
        : [];
    });
  } catch {
    return [];
  }
}

export function recordHistoricalTokenAccounts(
  connection: Connection,
  mint: string,
  accounts: readonly CachedHistoricalTokenAccount[],
): void {
  const database = connectionDatabases.get(connection as unknown as object);
  if (!database || accounts.length === 0) return;
  const now = Date.now();
  database.transaction(() => {
    for (const account of accounts) {
      const accountKey = `${mint}:${account.address}`;
      const existing = database.historyTokenAccounts
        .select()
        .where({ accountKey })
        .first() as
        | {
            initializedAtSlot?: number | null;
            initializedBySignature?: string | null;
            incarnationsJson?: string | null;
          }
        | undefined;
      const incarnations = normalizeIncarnations({
        initializedAtSlot: account.initializedAtSlot,
        initializedBySignature: account.initializedBySignature,
        incarnations: [
          ...parseIncarnations(existing?.incarnationsJson),
          ...(account.incarnations ?? []),
        ],
      });
      if (
        existing?.initializedAtSlot != null &&
        existing.initializedBySignature
      ) {
        incarnations.push(
          ...normalizeIncarnations({
            initializedAtSlot: existing.initializedAtSlot,
            initializedBySignature: existing.initializedBySignature,
            incarnations: [],
          }).filter(
            (row) =>
              !incarnations.some((item) => item.signature === row.signature),
          ),
        );
        incarnations.sort(
          (a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature),
        );
      }
      const first = incarnations[0] ?? null;
      database.historyTokenAccounts.upsert(
        {
          accountKey,
          mint,
          address: account.address,
          initializedAtSlot: first?.slot ?? null,
          initializedBySignature: first?.signature ?? null,
          incarnationsJson: JSON.stringify(incarnations),
          discoveredAtMs: now,
          updatedAtMs: now,
        },
        {
          on: "accountKey",
          merge: (table: any) => ({
            initializedAtSlot: table.excluded("initializedAtSlot"),
            initializedBySignature: table.excluded("initializedBySignature"),
            incarnationsJson: table.excluded("incarnationsJson"),
            updatedAtMs: table.max("updatedAtMs", 0),
          }),
        },
      );
    }
  });
}

export function cachedHistoricalTokenAccounts(
  connection: Connection,
  mint: string,
): CachedHistoricalTokenAccount[] {
  const database = connectionDatabases.get(connection as unknown as object);
  if (!database) return [];
  return (
    database.historyTokenAccounts.select().where({ mint }).all() as Array<{
      address: string;
      initializedAtSlot: number | null;
      initializedBySignature: string | null;
      incarnationsJson?: string | null;
    }>
  )
    .map((row) => {
      const incarnations = normalizeIncarnations({
        initializedAtSlot: row.initializedAtSlot,
        initializedBySignature: row.initializedBySignature,
        incarnations: parseIncarnations(row.incarnationsJson),
      });
      return {
        address: row.address,
        initializedAtSlot: incarnations[0]?.slot ?? row.initializedAtSlot,
        initializedBySignature:
          incarnations[0]?.signature ?? row.initializedBySignature,
        incarnations,
      };
    })
    .sort((a, b) => a.address.localeCompare(b.address));
}

export function recordDiscoveredSignatures(
  connection: Connection,
  scope: string | PublicKey,
  rows: ReadonlyArray<{
    signature: string;
    slot: number;
    err?: unknown;
    blockTime?: number | null;
    confirmationStatus?: string | null;
  }>,
): void {
  const database = connectionDatabases.get(connection as unknown as object);
  if (!database) return;
  cacheDiscovery({
    database,
    scope: typeof scope === "string" ? scope : scope.toBase58(),
    rows,
  });
}

function cachedDiscovery(args: {
  database: SolardDatabase;
  scope: string;
  options?: SignaturesForAddressOptions;
}): any[] {
  let rows = (
    args.database.historyDiscovery
      .select()
      .where({ scope: args.scope })
      .all() as Array<{
      signature: string;
      slot: number;
      errJson: string | null;
      blockTimeMs: number | null;
      confirmationStatus: string | null;
    }>
  ).sort((a, b) => b.slot - a.slot || b.signature.localeCompare(a.signature));
  if (args.options?.before) {
    const index = rows.findIndex(
      (row) => row.signature === args.options!.before,
    );
    rows = index >= 0 ? rows.slice(index + 1) : [];
  }
  if (args.options?.until) {
    const index = rows.findIndex(
      (row) => row.signature === args.options!.until,
    );
    if (index >= 0) rows = rows.slice(0, index);
  }
  const limit = Math.max(1, Math.min(1_000, args.options?.limit ?? 1_000));
  return rows.slice(0, limit).map((row) => ({
    signature: row.signature,
    slot: row.slot,
    err: row.errJson == null ? null : JSON.parse(row.errJson),
    memo: null,
    blockTime:
      row.blockTimeMs == null ? null : Math.floor(row.blockTimeMs / 1_000),
    confirmationStatus: row.confirmationStatus,
  }));
}

function cacheBlock(database: SolardDatabase, slot: number, block: any): void {
  const signatures = Array.isArray(block?.signatures) ? block.signatures : [];
  database.historyBlocks.upsert(
    {
      slot,
      signaturesJson: JSON.stringify(signatures),
      fetchedAtMs: Date.now(),
    },
    {
      on: "slot",
      merge: (table: any) => ({
        signaturesJson: table.excluded("signaturesJson"),
        fetchedAtMs: table.max("fetchedAtMs", 0),
      }),
    },
  );
}

function cachedBlock(database: SolardDatabase, slot: number): any | null {
  const row = database.historyBlocks.select().where({ slot }).first() as
    { signaturesJson?: string } | undefined;
  return row?.signaturesJson
    ? { signatures: JSON.parse(row.signaturesJson) }
    : null;
}

export function createRawTransactionCachingConnection(args: {
  connection: Connection;
  database: SolardDatabase;
  network?: boolean;
}): Connection {
  const network = args.network !== false;
  const original = args.connection;
  const proxy = new Proxy(original as any, {
    get(target, property, receiver) {
      if (property === "getParsedTransaction") {
        return async (
          signature: string,
          config?: { commitment?: Commitment },
        ) => {
          const cached = cachedParsedTransaction(args.database, signature);
          if (cached) return cached;
          if (!network) return null;
          const tx = await target.getParsedTransaction(signature, config);
          if (tx)
            cacheParsedTransaction({
              database: args.database,
              signature,
              transaction: tx,
              confidence:
                config?.commitment === "confirmed" ? "confirmed" : "finalized",
            });
          return tx;
        };
      }
      if (property === "getParsedTransactions") {
        return async (
          signatures: string[],
          config?: { commitment?: Commitment },
        ) => {
          const result: Array<ParsedTransactionWithMeta | null> =
            signatures.map((signature) =>
              cachedParsedTransaction(args.database, signature),
            );
          const missing = signatures
            .map((signature, index) => ({ signature, index }))
            .filter(({ index }) => result[index] == null);
          if (missing.length && network) {
            const fetched = await target.getParsedTransactions(
              missing.map((row) => row.signature),
              config,
            );
            for (let index = 0; index < missing.length; index += 1) {
              const tx = fetched[index];
              const row = missing[index]!;
              result[row.index] = tx;
              if (tx)
                cacheParsedTransaction({
                  database: args.database,
                  signature: row.signature,
                  transaction: tx,
                  confidence:
                    config?.commitment === "confirmed"
                      ? "confirmed"
                      : "finalized",
                });
            }
          }
          return result;
        };
      }
      if (property === "getSignaturesForAddress") {
        return async (
          address: PublicKey,
          options?: SignaturesForAddressOptions,
          commitment?: Commitment,
        ) => {
          const scope = scopeText(address);
          if (!network)
            return cachedDiscovery({ database: args.database, scope, options });
          const rows = await target.getSignaturesForAddress(
            address,
            options,
            commitment,
          );
          cacheDiscovery({ database: args.database, scope, rows });
          return rows;
        };
      }
      if (property === "getBlock") {
        return async (slot: number, config?: any) => {
          const cached = cachedBlock(args.database, slot);
          if (cached && config?.transactionDetails === "signatures")
            return cached;
          if (!network) return cached;
          const block = await target.getBlock(slot, config);
          if (block && config?.transactionDetails === "signatures")
            cacheBlock(args.database, slot, block);
          return block;
        };
      }
      if (property === "getSlot") {
        return async (commitment?: Commitment) => {
          if (!network) {
            const value = cachedHead(args.database);
            if (value == null)
              throw new Error("Raw transaction cache has no finalized head");
            return value;
          }
          const slot = await target.getSlot(commitment);
          if (commitment === "finalized" || commitment == null)
            saveHead(args.database, slot);
          return slot;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Connection;
  connectionDatabases.set(proxy as unknown as object, args.database);
  return proxy;
}

export function listCachedTransactions(database: SolardDatabase): Array<{
  signature: string;
  slot: number;
  transaction: ParsedTransactionWithMeta;
}> {
  return (
    database.rawTransactions.select().all() as Array<{
      signature: string;
      slot: number;
      transactionJson: string;
    }>
  )
    .map((row) => ({
      signature: row.signature,
      slot: row.slot,
      transaction: deserializeParsedTransaction(row.transactionJson),
    }))
    .sort((a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature));
}
