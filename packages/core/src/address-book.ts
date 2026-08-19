import { PublicKey } from "@solana/web3.js";

import { openDatabase } from "./db/database.ts";
import type { SolardDatabase } from "./db/schema.ts";

const SETTINGS_KEY = "address-book:external-contacts:v1";

export type ExternalContact = {
  name: string;
  address: string;
  createdAtMs: number;
  updatedAtMs: number;
};

type ExternalContactState = {
  version: 1;
  contacts: ExternalContact[];
};

function cleanName(value: string): string {
  const name = value.trim().replace(/^@/, "");
  if (!name) throw new Error("Contact name is required.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(
      "Contact name must be 1..64 characters using letters, numbers, dot, underscore, or hyphen.",
    );
  }
  try {
    new PublicKey(name);
    throw new Error(
      "Contact name must not itself be a Solana address; choose a human-readable alias.",
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("must not itself be a Solana address")
    ) {
      throw error;
    }
  }
  return name;
}

function canonicalAddress(value: string): string {
  const text = value.trim();
  if (!text) throw new Error("Contact address is required.");
  try {
    return new PublicKey(text).toBase58();
  } catch {
    throw new Error(`Invalid Solana address: ${text}`);
  }
}

function readState(db: SolardDatabase = openDatabase()): ExternalContactState {
  const row = db.settings.select().where({ key: SETTINGS_KEY }).first() as
    { value?: string } | undefined;

  if (!row?.value) return { version: 1, contacts: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch (error) {
    throw new Error("External contact address book is not valid JSON.", {
      cause: error,
    });
  }

  const contacts = (parsed as { contacts?: unknown })?.contacts;
  if (!Array.isArray(contacts)) {
    throw new Error("External contact address book has an invalid shape.");
  }

  return {
    version: 1,
    contacts: contacts.map((item) => {
      if (!item || typeof item !== "object") {
        throw new Error(
          "External contact address book contains an invalid row.",
        );
      }
      const row = item as Partial<ExternalContact>;
      if (
        typeof row.name !== "string" ||
        typeof row.address !== "string" ||
        typeof row.createdAtMs !== "number" ||
        typeof row.updatedAtMs !== "number"
      ) {
        throw new Error(
          "External contact address book contains an invalid row.",
        );
      }
      return {
        name: cleanName(row.name),
        address: canonicalAddress(row.address),
        createdAtMs: row.createdAtMs,
        updatedAtMs: row.updatedAtMs,
      };
    }),
  };
}

function writeState(
  state: ExternalContactState,
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

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function listExternalContacts(): ExternalContact[] {
  return readState()
    .contacts.slice()
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
}

export function findExternalContact(ref: string): ExternalContact | null {
  const value = ref.trim().replace(/^@/, "");
  if (!value) return null;
  const state = readState();
  return (
    state.contacts.find((row) => sameName(row.name, value)) ??
    state.contacts.find((row) => row.address === value) ??
    null
  );
}

export function addExternalContact(
  nameInput: string,
  addressInput: string,
  options: { overwrite?: boolean } = {},
): ExternalContact {
  const name = cleanName(nameInput);
  const address = canonicalAddress(addressInput);
  const db = openDatabase();
  const state = readState(db);

  const byName = state.contacts.find((row) => sameName(row.name, name));
  const byAddress = state.contacts.find((row) => row.address === address);

  if (byAddress && (!byName || !sameName(byAddress.name, byName.name))) {
    throw new Error(
      `Address ${address} is already registered as external contact @${byAddress.name}.`,
    );
  }

  if (byName) {
    if (byName.address === address) return byName;
    if (!options.overwrite) {
      throw new Error(
        `External contact @${byName.name} already points to ${byName.address}. Use --force to replace it.`,
      );
    }
    byName.address = address;
    byName.updatedAtMs = Date.now();
    writeState(state, db);
    return { ...byName };
  }

  const now = Date.now();
  const contact: ExternalContact = {
    name,
    address,
    createdAtMs: now,
    updatedAtMs: now,
  };
  state.contacts.push(contact);
  writeState(state, db);
  return { ...contact };
}

export function removeExternalContact(ref: string): ExternalContact {
  const value = ref.trim().replace(/^@/, "");
  const db = openDatabase();
  const state = readState(db);
  const index = state.contacts.findIndex(
    (row) => sameName(row.name, value) || row.address === value,
  );

  if (index < 0) throw new Error(`Unknown external contact: ${ref}`);

  const [removed] = state.contacts.splice(index, 1);
  writeState(state, db);
  return { ...removed! };
}
