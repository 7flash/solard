import {
  Keypair,
  PublicKey,
  type Connection,
  type Signer,
  type Transaction,
} from "@solana/web3.js";

import { createSolardActionContext } from "../actions/index.js";

export type AirdropRuntime = {
  connection: Connection;
  signer:
    | Signer
    | {
        publicKey: PublicKey;
        signTransaction(
          transaction: Transaction,
        ): Promise<Transaction> | Transaction;
      };
  close(): void;
};

function decodeBase58(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const indexes = new Map([...alphabet].map((char, index) => [char, index]));
  const bytes: number[] = [0];

  for (const character of value.trim()) {
    const digit = indexes.get(character);
    if (digit == null) throw new Error("Invalid base58 private key.");
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      const next = bytes[index] * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (const character of value) {
    if (character !== "1") break;
    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}

function secretBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item))) {
    return Uint8Array.from(value as number[]);
  }
  if (typeof value !== "string") return null;

  const text = value.trim();
  if (!text) return null;
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? Uint8Array.from(parsed) : null;
    } catch {
      return null;
    }
  }
  if (/^\d+(?:\s*,\s*\d+)+$/.test(text)) {
    return Uint8Array.from(text.split(",").map((item) => Number(item.trim())));
  }
  try {
    return decodeBase58(text);
  } catch {
    return null;
  }
}

function signerFrom(
  value: unknown,
  depth = 0,
): AirdropRuntime["signer"] | null {
  if (!value || depth > 5) return null;
  if (value instanceof Keypair) return value;

  if (typeof value === "object") {
    const row = value as Record<string, any>;
    const publicKey = row.publicKey;
    if (publicKey && typeof row.signTransaction === "function") {
      return {
        publicKey:
          publicKey instanceof PublicKey ? publicKey : new PublicKey(publicKey),
        signTransaction: row.signTransaction.bind(row),
      };
    }

    const bytes =
      secretBytes(row.secretKey) ??
      secretBytes(row.privateKey) ??
      secretBytes(row.key) ??
      secretBytes(row.secret);
    if (bytes) {
      if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
      if (bytes.length === 32) return Keypair.fromSeed(bytes);
    }

    for (const key of [
      "keypair",
      "signer",
      "payer",
      "wallet",
      "account",
      "value",
      "data",
    ]) {
      const nested = signerFrom(row[key], depth + 1);
      if (nested) return nested;
    }
  }

  return null;
}

async function callCandidate(
  root: any,
  name: string,
  wallet: string,
): Promise<unknown> {
  const fn = root?.[name];
  if (typeof fn !== "function") return null;
  try {
    return await fn.call(root, wallet);
  } catch {
    return null;
  }
}

async function resolveSigner(
  roots: any[],
  wallet: string,
): Promise<AirdropRuntime["signer"]> {
  const methodNames = [
    "resolveSigner",
    "getSigner",
    "walletSigner",
    "signer",
    "resolveWallet",
    "getWallet",
    "loadWallet",
    "wallet",
  ];

  for (const root of roots) {
    const direct = signerFrom(root);
    if (direct && direct.publicKey.toBase58() === wallet) return direct;

    for (const method of methodNames) {
      const candidate = signerFrom(await callCandidate(root, method, wallet));
      if (candidate && candidate.publicKey.toBase58() === wallet)
        return candidate;
    }

    for (const storeName of ["wallets", "walletStore", "store", "vault"]) {
      const store = root?.[storeName];
      for (const method of ["get", "find", "resolve", "load"]) {
        const candidate = signerFrom(
          await callCandidate(store, method, wallet),
        );
        if (candidate && candidate.publicKey.toBase58() === wallet)
          return candidate;
      }
    }
  }

  throw new Error(
    `Managed wallet ${wallet} is loaded in the UI but its server signer could not be resolved. ` +
      "Wire the existing encrypted wallet store into src/solard/airdrops/runtime.ts; no external executor is required.",
  );
}

function resolveConnection(roots: any[]): Connection {
  for (const root of roots) {
    if (!root) continue;
    if (typeof root.connection === "function") {
      const value = root.connection();
      if (value?.getLatestBlockhash && value?.sendRawTransaction)
        return value as Connection;
    }
    if (
      root.connection?.getLatestBlockhash &&
      root.connection?.sendRawTransaction
    ) {
      return root.connection as Connection;
    }
  }
  throw new Error(
    "The Solard action context did not expose a Solana connection.",
  );
}

export async function openAirdropRuntime(
  wallet: string,
  suppliedRoot?: unknown,
): Promise<AirdropRuntime> {
  const expected = new PublicKey(wallet).toBase58();
  const ctx = suppliedRoot
    ? null
    : (createSolardActionContext({ installSenders: false }) as any);
  const root = suppliedRoot as any;
  const roots = [
    root,
    root?.sowl,
    root?.runtime,
    root?.services,
    root?.app,
    ctx,
    ctx?.sowl,
    ctx?.runtime,
    ctx?.services,
    ctx?.app,
  ].filter(Boolean);

  try {
    const connection = resolveConnection(roots);
    const signer = await resolveSigner(roots, expected);
    if (signer.publicKey.toBase58() !== expected) {
      throw new Error(
        "Resolved signer does not match the selected bank wallet.",
      );
    }
    return {
      connection,
      signer,
      close: () => {
        if (typeof ctx?.close === "function") ctx.close();
      },
    };
  } catch (error) {
    if (typeof ctx?.close === "function") ctx.close();
    throw error;
  }
}
