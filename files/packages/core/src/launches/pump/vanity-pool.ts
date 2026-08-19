import { Keypair } from "@solana/web3.js";

import {
  decryptKeypair,
  encryptKeypair,
  type EncryptedSecret,
} from "../../core/keypair.ts";
import { openDatabase } from "../../db/database.ts";
import type { SolardDatabase } from "../../db/schema.ts";
import { cleanVanitySuffix } from "./vanity-mint.ts";

const SETTINGS_KEY = "launch:vanity-mint-pool:v1";

export type VanityMintPoolStatus = "available" | "reserved" | "used";

type StoredVanityMint = EncryptedSecret & {
  address: string;
  suffix: string;
  status: VanityMintPoolStatus;
  createdAtMs: number;
  reservedAtMs: number | null;
  usedAtMs: number | null;
  reservationReason: string | null;
};

type VanityMintPoolState = {
  version: 1;
  entries: StoredVanityMint[];
};

export type VanityMintPoolEntry = {
  address: string;
  suffix: string;
  status: VanityMintPoolStatus;
  createdAtMs: number;
  reservedAtMs: number | null;
  usedAtMs: number | null;
  reservationReason: string | null;
};

export type VanityMintPoolReservation = VanityMintPoolEntry & {
  mint: Keypair;
};

function publicEntry(row: StoredVanityMint): VanityMintPoolEntry {
  return {
    address: row.address,
    suffix: row.suffix,
    status: row.status,
    createdAtMs: row.createdAtMs,
    reservedAtMs: row.reservedAtMs,
    usedAtMs: row.usedAtMs,
    reservationReason: row.reservationReason,
  };
}

function readState(db: SolardDatabase = openDatabase()): VanityMintPoolState {
  const row = db.settings.select().where({ key: SETTINGS_KEY }).first() as
    { value?: string } | undefined;

  if (!row?.value) return { version: 1, entries: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch (error) {
    throw new Error("Vanity mint pool state is not valid JSON.", {
      cause: error,
    });
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new Error("Vanity mint pool state has an invalid shape.");
  }

  return {
    version: 1,
    entries: (parsed as VanityMintPoolState).entries,
  };
}

function writeState(
  state: VanityMintPoolState,
  db: SolardDatabase = openDatabase(),
): void {
  const value = JSON.stringify(state);
  const now = Date.now();
  const existing = db.settings.select().where({ key: SETTINGS_KEY }).first() as
    { value?: string; updatedAtMs?: number } | undefined;

  if (existing) {
    existing.value = value;
    existing.updatedAtMs = now;
  } else {
    db.settings.insert({
      key: SETTINGS_KEY,
      value,
      updatedAtMs: now,
    });
  }
}

export function listVanityMintPool(
  options: {
    suffix?: string;
    status?: VanityMintPoolStatus;
  } = {},
): VanityMintPoolEntry[] {
  const suffix = options.suffix ? cleanVanitySuffix(options.suffix) : undefined;

  return readState()
    .entries.filter((row) => !suffix || row.suffix === suffix)
    .filter((row) => !options.status || row.status === options.status)
    .sort((left, right) => left.createdAtMs - right.createdAtMs)
    .map(publicEntry);
}

export function addVanityMintToPool(
  mint: Keypair,
  suffixInput: string,
): VanityMintPoolEntry {
  const suffix = cleanVanitySuffix(suffixInput);
  const address = mint.publicKey.toBase58();

  if (!address.endsWith(suffix)) {
    throw new Error(
      `Mint ${address} does not end with required suffix ${suffix}.`,
    );
  }

  const db = openDatabase();
  const state = readState(db);
  const duplicate = state.entries.find((row) => row.address === address);
  if (duplicate) {
    throw new Error(
      `Vanity mint ${address} is already in the pool with status ${duplicate.status}.`,
    );
  }

  const secret = encryptKeypair(mint);
  const now = Date.now();
  const row: StoredVanityMint = {
    address,
    suffix,
    ...secret,
    status: "available",
    createdAtMs: now,
    reservedAtMs: null,
    usedAtMs: null,
    reservationReason: null,
  };

  state.entries.push(row);
  writeState(state, db);
  return publicEntry(row);
}

export function reserveVanityMintFromPool(
  suffixInput: string,
  options: {
    address?: string | null;
    reason?: string | null;
  } = {},
): VanityMintPoolReservation {
  const suffix = cleanVanitySuffix(suffixInput);
  const requestedAddress = options.address?.trim() || null;
  const db = openDatabase();
  const state = readState(db);

  const row = state.entries.find(
    (item) =>
      item.status === "available" &&
      item.suffix === suffix &&
      (!requestedAddress || item.address === requestedAddress),
  );

  if (!row) {
    const available = state.entries.filter(
      (item) => item.status === "available" && item.suffix === suffix,
    ).length;
    throw new Error(
      requestedAddress
        ? `Vanity mint ${requestedAddress} is not available in suffix pool ${suffix}.`
        : `Vanity mint pool ${suffix} has no available mints (available=${available}). ` +
            `Generate more with: slrd vanity pool generate --suffix ${suffix} --count <n>`,
    );
  }

  const mint = decryptKeypair(row);
  const derived = mint.publicKey.toBase58();
  if (derived !== row.address) {
    throw new Error(
      `Vanity mint pool secret mismatch: stored=${row.address} derived=${derived}.`,
    );
  }

  row.status = "reserved";
  row.reservedAtMs = Date.now();
  row.reservationReason = options.reason?.trim() || "launch";
  writeState(state, db);

  return {
    ...publicEntry(row),
    mint,
  };
}

export function releaseVanityMintReservation(
  address: string,
): VanityMintPoolEntry {
  const db = openDatabase();
  const state = readState(db);
  const row = state.entries.find((item) => item.address === address);

  if (!row) throw new Error(`Vanity mint is not in the pool: ${address}`);
  if (row.status === "used") {
    throw new Error(
      `Vanity mint ${address} is already marked used and cannot be released.`,
    );
  }
  if (row.status === "available") return publicEntry(row);

  row.status = "available";
  row.reservedAtMs = null;
  row.reservationReason = null;
  writeState(state, db);
  return publicEntry(row);
}

export function markVanityMintUsed(address: string): VanityMintPoolEntry {
  const db = openDatabase();
  const state = readState(db);
  const row = state.entries.find((item) => item.address === address);

  if (!row) throw new Error(`Vanity mint is not in the pool: ${address}`);
  if (row.status === "used") return publicEntry(row);

  row.status = "used";
  row.usedAtMs = Date.now();
  row.reservationReason = null;
  writeState(state, db);
  return publicEntry(row);
}
