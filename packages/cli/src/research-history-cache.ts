import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";

export type ResearchHistorySignature = {
  mint: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  scanKind: "curve" | "pool";
  scanAddress: string;
  localChronologicalOrder: number;
};

export type ResearchHistoryMeta = {
  version: 1;
  mint: string;
  decimals: number;
  supplyUi: number;
  quoteMint: string | null;
  bondingCurve: string | null;
  pool: string | null;
  fromCreation: boolean;
  indexedSignatures: number;
  indexedAtMs: number;
};

type Encoded =
  null | boolean | number | string | Encoded[] | { [key: string]: Encoded };

function cachePath(): string {
  return resolve(
    process.env.SLRD_RESEARCH_DB_PATH?.trim() ||
      process.env.SOLARD_RESEARCH_DB_PATH?.trim() ||
      resolve(homedir(), ".solard", "research.sqlite"),
  );
}

function open(): Database {
  const path = cachePath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_history_signatures (
      mint TEXT NOT NULL,
      signature TEXT NOT NULL,
      slot INTEGER NOT NULL,
      block_time INTEGER,
      scan_kind TEXT NOT NULL,
      scan_address TEXT NOT NULL,
      local_order INTEGER NOT NULL,
      PRIMARY KEY (mint, signature)
    );
    CREATE INDEX IF NOT EXISTS token_history_signatures_time
      ON token_history_signatures (mint, block_time, slot, local_order);
    CREATE TABLE IF NOT EXISTS token_history_meta (
      mint TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS raw_transactions (
      signature TEXT PRIMARY KEY,
      slot INTEGER NOT NULL,
      block_time_ms INTEGER,
      confidence TEXT NOT NULL,
      transaction_json TEXT NOT NULL,
      fetched_at_ms INTEGER NOT NULL
    );
  `);
  return db;
}

function encode(value: unknown): Encoded {
  if (
    value == null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return value;
  if (typeof value === "bigint")
    return { $bigint: value.toString() } as Encoded;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return { $bytes: Buffer.from(value).toString("base64") } as Encoded;
  if (value instanceof PublicKey)
    return { $publicKey: value.toBase58() } as Encoded;
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === "object") {
    const toBase58 = (value as { toBase58?: unknown }).toBase58;
    if (typeof toBase58 === "function")
      return {
        $publicKey: (value as { toBase58(): string }).toBase58(),
      } as Encoded;
    const out: Record<string, Encoded> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      out[key] = encode(item);
    return out;
  }
  throw new Error(`Unsupported research cache value: ${typeof value}`);
}

function decode(value: Encoded): unknown {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  if ("$publicKey" in value) return new PublicKey(String(value.$publicKey));
  if ("$bytes" in value) return Buffer.from(String(value.$bytes), "base64");
  if ("$bigint" in value) return BigInt(String(value.$bigint));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    out[key] = decode(item as Encoded);
  return out;
}

export function researchHistoryCachePath(): string {
  return cachePath();
}

export function replaceResearchHistoryIndex(args: {
  mint: string;
  rows: ResearchHistorySignature[];
  meta: ResearchHistoryMeta;
}): void {
  const db = open();
  try {
    const remove = db.prepare(
      "DELETE FROM token_history_signatures WHERE mint = ?",
    );
    const insert = db.prepare(`
      INSERT OR REPLACE INTO token_history_signatures
      (mint, signature, slot, block_time, scan_kind, scan_address, local_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const writeMeta = db.prepare(`
      INSERT INTO token_history_meta (mint, json, updated_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(mint) DO UPDATE SET json=excluded.json, updated_at_ms=excluded.updated_at_ms
    `);
    const tx = db.transaction(() => {
      remove.run(args.mint);
      for (const row of args.rows) {
        insert.run(
          args.mint,
          row.signature,
          row.slot,
          row.blockTime,
          row.scanKind,
          row.scanAddress,
          row.localChronologicalOrder,
        );
      }
      writeMeta.run(args.mint, JSON.stringify(args.meta), Date.now());
    });
    tx();
  } finally {
    db.close();
  }
}

export function researchHistoryMeta(mint: string): ResearchHistoryMeta | null {
  const db = open();
  try {
    const row = db
      .prepare("SELECT json FROM token_history_meta WHERE mint = ?")
      .get(mint) as { json?: string } | null;
    return row?.json ? (JSON.parse(row.json) as ResearchHistoryMeta) : null;
  } finally {
    db.close();
  }
}

export function loadResearchHistoryIndex(
  mint: string,
  options: { fromMs?: number; toMs?: number } = {},
): ResearchHistorySignature[] {
  const db = open();
  try {
    const rows = db
      .prepare(
        `
        SELECT mint, signature, slot, block_time, scan_kind, scan_address, local_order
        FROM token_history_signatures
        WHERE mint = ?
        ORDER BY COALESCE(block_time, 0), slot, local_order, signature
      `,
      )
      .all(mint) as Array<{
      mint: string;
      signature: string;
      slot: number;
      block_time: number | null;
      scan_kind: "curve" | "pool";
      scan_address: string;
      local_order: number;
    }>;
    return rows
      .map((row) => ({
        mint: row.mint,
        signature: row.signature,
        slot: Number(row.slot),
        blockTime: row.block_time == null ? null : Number(row.block_time),
        scanKind: row.scan_kind,
        scanAddress: row.scan_address,
        localChronologicalOrder: Number(row.local_order),
      }))
      .filter(
        (row) =>
          options.fromMs == null ||
          row.blockTime == null ||
          row.blockTime * 1_000 >= options.fromMs,
      )
      .filter(
        (row) =>
          options.toMs == null ||
          row.blockTime == null ||
          row.blockTime * 1_000 <= options.toMs,
      );
  } finally {
    db.close();
  }
}

export function sampleResearchHistoryIndex(
  rows: readonly ResearchHistorySignature[],
  sampleMs: number,
): ResearchHistorySignature[] {
  if (!(sampleMs > 0)) return [...rows];
  const selected = new Map<string, ResearchHistorySignature>();
  const buckets = new Map<number, ResearchHistorySignature>();
  const add = (row: ResearchHistorySignature | undefined) => {
    if (row) selected.set(row.signature, row);
  };
  add(rows[0]);
  add(rows.at(-1));
  add(rows.find((row) => row.scanKind === "curve"));
  add(rows.find((row) => row.scanKind === "pool"));
  for (const row of rows) {
    if (row.blockTime == null) continue;
    const bucket = Math.floor((row.blockTime * 1_000) / sampleMs);
    const previous = buckets.get(bucket);
    if (
      !previous ||
      row.slot > previous.slot ||
      (row.slot === previous.slot &&
        row.localChronologicalOrder > previous.localChronologicalOrder)
    )
      buckets.set(bucket, row);
  }
  for (const row of buckets.values()) add(row);
  return [...selected.values()].sort(
    (a, b) =>
      (a.blockTime ?? 0) - (b.blockTime ?? 0) ||
      a.slot - b.slot ||
      a.localChronologicalOrder - b.localChronologicalOrder ||
      a.signature.localeCompare(b.signature),
  );
}

export function cachedResearchTransactions(
  signatures: readonly string[],
): Map<string, ParsedTransactionWithMeta> {
  const out = new Map<string, ParsedTransactionWithMeta>();
  if (!signatures.length) return out;
  const db = open();
  try {
    const get = db.prepare(
      "SELECT transaction_json FROM raw_transactions WHERE signature = ?",
    );
    for (const signature of signatures) {
      const row = get.get(signature) as { transaction_json?: string } | null;
      if (!row?.transaction_json) continue;
      out.set(
        signature,
        decode(
          JSON.parse(row.transaction_json) as Encoded,
        ) as ParsedTransactionWithMeta,
      );
    }
    return out;
  } finally {
    db.close();
  }
}

export function cacheResearchTransactions(
  rows: ReadonlyMap<string, ParsedTransactionWithMeta>,
  confidence: "confirmed" | "finalized",
): void {
  if (!rows.size) return;
  const db = open();
  try {
    const insert = db.prepare(`
      INSERT INTO raw_transactions
      (signature, slot, block_time_ms, confidence, transaction_json, fetched_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(signature) DO UPDATE SET
        slot=excluded.slot,
        block_time_ms=excluded.block_time_ms,
        confidence=excluded.confidence,
        transaction_json=excluded.transaction_json,
        fetched_at_ms=excluded.fetched_at_ms
    `);
    const now = Date.now();
    const tx = db.transaction(() => {
      for (const [signature, transaction] of rows) {
        insert.run(
          signature,
          transaction.slot,
          transaction.blockTime == null ? null : transaction.blockTime * 1_000,
          confidence,
          JSON.stringify(encode(transaction)),
          now,
        );
      }
    });
    tx();
  } finally {
    db.close();
  }
}

export function countCachedResearchTransactions(
  signatures: readonly string[],
): number {
  if (!signatures.length) return 0;
  const cached = cachedResearchTransactions(signatures);
  return cached.size;
}
