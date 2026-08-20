import { PublicKey } from "@solana/web3.js";

import type {
  BrowserContact,
  BrowserStorageLike,
  BrowserTokenAlias,
} from "./types.ts";

type StoredCollection<T> = {
  version: 1;
  rows: T[];
};

function cleanAlias(value: string, kind: string): string {
  const alias = value.trim().replace(/^@/, "");
  if (!alias) throw new Error(`${kind} alias is required.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias)) {
    throw new Error(
      `${kind} alias must be 1..64 characters using letters, numbers, dot, underscore, or hyphen.`,
    );
  }
  return alias;
}

function canonicalAddress(value: string): string {
  try {
    return new PublicKey(value.trim()).toBase58();
  } catch {
    throw new Error(`Invalid Solana address: ${value}`);
  }
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export class MemoryBrowserStorage implements BrowserStorageLike {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

export function defaultBrowserStorage(): BrowserStorageLike {
  const storage = globalThis.localStorage;
  if (!storage) {
    throw new Error(
      "localStorage is unavailable. Pass a BrowserStorageLike adapter explicitly.",
    );
  }
  return storage;
}

export class BrowserSolardStore {
  constructor(
    readonly storage: BrowserStorageLike = defaultBrowserStorage(),
    readonly namespace = "solard:browser:v1",
  ) {}

  private key(name: string): string {
    return `${this.namespace}:${name}`;
  }

  private readCollection<T>(name: string): StoredCollection<T> {
    const raw = this.storage.getItem(this.key(name));
    if (!raw) return { version: 1, rows: [] };

    const parsed = JSON.parse(raw) as Partial<StoredCollection<T>>;
    if (!Array.isArray(parsed.rows)) {
      throw new Error(`Invalid browser storage collection: ${name}`);
    }
    return { version: 1, rows: parsed.rows };
  }

  private writeCollection<T>(name: string, rows: T[]): void {
    this.storage.setItem(
      this.key(name),
      JSON.stringify({ version: 1, rows } satisfies StoredCollection<T>),
    );
  }

  listContacts(): BrowserContact[] {
    return this.readCollection<BrowserContact>("contacts")
      .rows.slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  addContact(
    nameInput: string,
    addressInput: string,
    options: { overwrite?: boolean } = {},
  ): BrowserContact {
    const name = cleanAlias(nameInput, "Contact");
    const address = canonicalAddress(addressInput);
    const rows = this.listContacts();
    const byName = rows.find((row) => sameName(row.name, name));
    const byAddress = rows.find((row) => row.address === address);

    if (byAddress && (!byName || !sameName(byAddress.name, byName.name))) {
      throw new Error(
        `${address} is already saved as contact @${byAddress.name}.`,
      );
    }

    if (byName) {
      if (byName.address === address) return byName;
      if (!options.overwrite) {
        throw new Error(
          `Contact @${byName.name} already points to ${byName.address}.`,
        );
      }
      byName.address = address;
      byName.updatedAtMs = Date.now();
      this.writeCollection("contacts", rows);
      return { ...byName };
    }

    const now = Date.now();
    const row: BrowserContact = {
      name,
      address,
      createdAtMs: now,
      updatedAtMs: now,
    };
    rows.push(row);
    this.writeCollection("contacts", rows);
    return { ...row };
  }

  findContact(ref: string): BrowserContact | null {
    const value = ref.trim().replace(/^@/, "");
    return (
      this.listContacts().find((row) => sameName(row.name, value)) ??
      this.listContacts().find((row) => row.address === value) ??
      null
    );
  }

  removeContact(ref: string): BrowserContact {
    const value = ref.trim().replace(/^@/, "");
    const rows = this.listContacts();
    const index = rows.findIndex(
      (row) => sameName(row.name, value) || row.address === value,
    );
    if (index < 0) throw new Error(`Unknown browser contact: ${ref}`);
    const [removed] = rows.splice(index, 1);
    this.writeCollection("contacts", rows);
    return { ...removed! };
  }

  listTokenAliases(): BrowserTokenAlias[] {
    return this.readCollection<BrowserTokenAlias>("tokens")
      .rows.slice()
      .sort((a, b) => a.alias.localeCompare(b.alias));
  }

  registerToken(
    aliasInput: string,
    mintInput: string,
    options: { overwrite?: boolean } = {},
  ): BrowserTokenAlias {
    const alias = cleanAlias(aliasInput.replace(/^\$/, ""), "Token");
    const mint = canonicalAddress(mintInput);
    const rows = this.listTokenAliases();
    const existing = rows.find((row) => sameName(row.alias, alias));

    if (existing) {
      if (existing.mint === mint) return existing;
      if (!options.overwrite) {
        throw new Error(
          `Token alias ${alias} already points to ${existing.mint}.`,
        );
      }
      existing.mint = mint;
      existing.updatedAtMs = Date.now();
      this.writeCollection("tokens", rows);
      return { ...existing };
    }

    const now = Date.now();
    const row: BrowserTokenAlias = {
      alias,
      mint,
      createdAtMs: now,
      updatedAtMs: now,
    };
    rows.push(row);
    this.writeCollection("tokens", rows);
    return { ...row };
  }

  resolveToken(ref: string): string {
    const value = ref.trim().replace(/^\$/, "");
    try {
      return new PublicKey(value).toBase58();
    } catch {
      // Alias resolution below.
    }

    const lowered = value.toLowerCase();
    const accepted =
      lowered === "slrd" ? new Set(["slrd", "solard"]) : new Set([lowered]);

    const row = this.listTokenAliases().find((item) =>
      accepted.has(item.alias.toLowerCase()),
    );
    if (!row) {
      throw new Error(
        `Unknown browser token alias "${ref}". Register it with tokens.register(alias, mint) or pass a mint address.`,
      );
    }
    return row.mint;
  }

  setSetting<T>(name: string, value: T): void {
    this.storage.setItem(this.key(`setting:${name}`), JSON.stringify(value));
  }

  getSetting<T>(name: string, fallback: T): T {
    const raw = this.storage.getItem(this.key(`setting:${name}`));
    return raw == null ? fallback : (JSON.parse(raw) as T);
  }

  removeSetting(name: string): void {
    this.storage.removeItem(this.key(`setting:${name}`));
  }

  resolveDestination(ref: string): string {
    const contact = this.findContact(ref);
    if (contact) return contact.address;
    return canonicalAddress(ref);
  }
}
