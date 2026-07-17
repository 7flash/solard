import {
  Keypair,
  PublicKey,
  type Connection,
  type Signer,
  type Transaction,
} from "@solana/web3.js";

import { createSolardActionContext } from "../actions/index.js";

export type ManagedAirdropSigner =
  | Signer
  | {
      publicKey: PublicKey;
      signTransaction(
        transaction: Transaction,
      ): Promise<Transaction> | Transaction;
    };

export type AirdropRuntime = {
  connection: Connection;
  signer: ManagedAirdropSigner;
  close(): void;
};

function bytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item))) {
    return Uint8Array.from(value as number[]);
  }
  return null;
}

function signerFrom(value: unknown, depth = 0): ManagedAirdropSigner | null {
  if (!value || depth > 6) return null;
  if (value instanceof Keypair) return value;
  if (typeof value !== "object") return null;

  const row = value as Record<string, any>;
  if (row.publicKey && typeof row.signTransaction === "function") {
    return {
      publicKey:
        row.publicKey instanceof PublicKey
          ? row.publicKey
          : new PublicKey(row.publicKey),
      signTransaction: row.signTransaction.bind(row),
    };
  }

  const secret =
    bytes(row.secretKey) ??
    bytes(row.privateKey) ??
    bytes(row.key) ??
    bytes(row.secret);
  if (secret?.length === 64) return Keypair.fromSecretKey(secret);
  if (secret?.length === 32) return Keypair.fromSeed(secret);

  for (const key of [
    "keypair",
    "signer",
    "payer",
    "wallet",
    "account",
    "target",
    "value",
    "data",
  ]) {
    const nested = signerFrom(row[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

async function call(
  root: any,
  method: string,
  wallet: string,
): Promise<unknown[]> {
  const fn = root?.[method];
  if (typeof fn !== "function") return [];
  const results: unknown[] = [];
  for (const argument of [wallet, { wallet }, { address: wallet }]) {
    try {
      results.push(await fn.call(root, argument));
    } catch {
      // Different internal wallet APIs accept different target shapes.
    }
  }
  return results;
}

function matchingSigner(
  value: unknown,
  wallet: string,
): ManagedAirdropSigner | null {
  const signer = signerFrom(value);
  return signer?.publicKey.toBase58() === wallet ? signer : null;
}

async function resolveSigner(
  roots: any[],
  wallet: string,
): Promise<ManagedAirdropSigner> {
  const methods = [
    "resolveManagedWalletSigner",
    "resolveWalletSigner",
    "resolveSigner",
    "getSigner",
    "walletSigner",
    "walletKeypair",
    "keypairForWallet",
    "loadKeypair",
    "resolveWallet",
    "getWallet",
    "loadWallet",
    "resolveTarget",
    "getTarget",
    "wallet",
  ];

  for (const root of roots) {
    const direct = matchingSigner(root, wallet);
    if (direct) return direct;

    for (const method of methods) {
      for (const result of await call(root, method, wallet)) {
        const signer = matchingSigner(result, wallet);
        if (signer) return signer;
      }
    }

    for (const storeName of [
      "wallets",
      "walletStore",
      "walletRepository",
      "store",
      "vault",
    ]) {
      let store: any = null;
      try {
        store =
          typeof root?.[storeName] === "function"
            ? await root[storeName].call(root)
            : root?.[storeName];
      } catch {
        store = null;
      }
      if (!store) continue;
      if (Array.isArray(store)) {
        for (const item of store) {
          const signer = matchingSigner(item, wallet);
          if (signer) return signer;
        }
      }
      for (const method of [
        "getSigner",
        "resolveSigner",
        "get",
        "find",
        "resolve",
        "load",
      ]) {
        for (const result of await call(store, method, wallet)) {
          const signer = matchingSigner(result, wallet);
          if (signer) return signer;
        }
      }
    }
  }

  throw new Error(
    `The managed signer for ${wallet} could not be resolved from the Solard action context. ` +
      "Connect the encrypted wallet store in src/solard/airdrops/runtime.ts. " +
      "Execution remains entirely server-side; no browser key or external executor is used.",
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
): Promise<AirdropRuntime> {
  const expected = new PublicKey(wallet).toBase58();
  const ctx = createSolardActionContext({ installSenders: false }) as any;
  const roots = [ctx, ctx?.sowl, ctx?.runtime, ctx?.services, ctx?.app].filter(
    Boolean,
  );

  try {
    const connection = resolveConnection(roots);
    const signer = await resolveSigner(roots, expected);
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
