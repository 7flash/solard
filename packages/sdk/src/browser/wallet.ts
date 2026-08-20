import {
  Keypair,
  Transaction,
  VersionedTransaction,
  type PublicKey,
} from "@solana/web3.js";

import type { BrowserStorageLike, BrowserWalletSigner } from "./types.ts";
import { defaultBrowserStorage } from "./storage.ts";

type StoredKeypair = {
  version: 1;
  name: string;
  publicKey: string;
  salt: string;
  iv: string;
  ciphertext: string;
  iterations: number;
  createdAtMs: number;
};

const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function requireCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("WebCrypto SubtleCrypto is unavailable in this browser.");
  }
  return subtle;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  if (!password) throw new Error("A non-empty vault password is required.");
  const subtle = requireCrypto();
  const material = await subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return await subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export class KeypairBrowserSigner implements BrowserWalletSigner {
  readonly publicKey: PublicKey;

  constructor(private readonly keypair: Keypair) {
    this.publicKey = keypair.publicKey;
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
  ): Promise<T> {
    if (transaction instanceof VersionedTransaction) {
      transaction.sign([this.keypair]);
    } else {
      transaction.partialSign(this.keypair);
    }
    return transaction;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(
    transactions: T[],
  ): Promise<T[]> {
    for (const transaction of transactions) {
      await this.signTransaction(transaction);
    }
    return transactions;
  }
}

/**
 * Optional local-key mode for browser-only apps.
 *
 * Secret bytes are AES-GCM encrypted before being written to localStorage.
 * For user-facing trading apps, an injected wallet extension remains the
 * preferred signer because XSS can access any origin's localStorage.
 */
export class BrowserKeyVault {
  constructor(
    private readonly storage: BrowserStorageLike = defaultBrowserStorage(),
    private readonly namespace = "solard:browser:v1:vault",
  ) {}

  private key(name: string): string {
    return `${this.namespace}:${name.trim()}`;
  }

  list(): Array<{ name: string; publicKey: string; createdAtMs: number }> {
    const prefix = `${this.namespace}:`;
    const rows: Array<{
      name: string;
      publicKey: string;
      createdAtMs: number;
    }> = [];

    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const raw = this.storage.getItem(key);
      if (!raw) continue;
      const row = JSON.parse(raw) as StoredKeypair;
      rows.push({
        name: row.name,
        publicKey: row.publicKey,
        createdAtMs: row.createdAtMs,
      });
    }

    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(
    nameInput: string,
    keypair: Keypair,
    password: string,
    options: { overwrite?: boolean; iterations?: number } = {},
  ): Promise<void> {
    const name = nameInput.trim();
    if (!name) throw new Error("Vault key name is required.");
    const storageKey = this.key(name);
    if (this.storage.getItem(storageKey) && !options.overwrite) {
      throw new Error(`Browser vault key "${name}" already exists.`);
    }

    const iterations = Math.max(100_000, options.iterations ?? 310_000);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, iterations);
    const encrypted = await requireCrypto().encrypt(
      { name: "AES-GCM", iv },
      key,
      keypair.secretKey,
    );

    const row: StoredKeypair = {
      version: 1,
      name,
      publicKey: keypair.publicKey.toBase58(),
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encrypted)),
      iterations,
      createdAtMs: Date.now(),
    };
    this.storage.setItem(storageKey, JSON.stringify(row));
  }

  async generate(
    name: string,
    password: string,
    options: { overwrite?: boolean; iterations?: number } = {},
  ): Promise<KeypairBrowserSigner> {
    const keypair = Keypair.generate();
    await this.save(name, keypair, password, options);
    return new KeypairBrowserSigner(keypair);
  }

  async unlock(
    nameInput: string,
    password: string,
  ): Promise<KeypairBrowserSigner> {
    const name = nameInput.trim();
    const raw = this.storage.getItem(this.key(name));
    if (!raw) throw new Error(`Unknown browser vault key: ${name}`);

    const row = JSON.parse(raw) as StoredKeypair;
    if (row.version !== 1) {
      throw new Error(`Unsupported browser vault version: ${row.version}`);
    }

    try {
      const salt = base64ToBytes(row.salt);
      const iv = base64ToBytes(row.iv);
      const ciphertext = base64ToBytes(row.ciphertext);
      const key = await deriveKey(password, salt, row.iterations);
      const plain = await requireCrypto().decrypt(
        { name: "AES-GCM", iv },
        key,
        ciphertext,
      );
      const keypair = Keypair.fromSecretKey(new Uint8Array(plain));
      if (keypair.publicKey.toBase58() !== row.publicKey) {
        throw new Error("Decrypted key does not match stored public key.");
      }
      return new KeypairBrowserSigner(keypair);
    } catch (error) {
      throw new Error("Unable to decrypt browser wallet.", { cause: error });
    }
  }

  remove(name: string): void {
    this.storage.removeItem(this.key(name.trim()));
  }
}
