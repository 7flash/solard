import { Keypair, PublicKey } from "@solana/web3.js";
import {
  encryptKeypair,
  decryptKeypair,
  parseKeypair,
} from "../core/keypair.ts";
import { measure } from "../core/log.ts";
import { walletLog } from "../core/log-result.ts";
import { measuredSync } from "../core/measured.ts";
import { UnknownWalletError, WalletCannotSignError } from "../core/errors.ts";
import type { WalletRef } from "../core/refs.ts";
import type { SolardDatabase, WalletRow } from "./schema.ts";

const m = measure("wallets");
function clean(ref: string): string {
  return ref.startsWith("@") ? ref.slice(1) : ref;
}
function maybeAddress(value: string): string | null {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return null;
  }
}

export class WalletRepo {
  constructor(private readonly db: SolardDatabase) {}

  import(privateKey: string, name?: string): WalletRow {
    return measuredSync(
      m,
      "import",
      () => {
        const keypair = parseKeypair(privateKey);
        const address = keypair.publicKey.toBase58();
        const encrypted = encryptKeypair(keypair);
        const resolvedName = clean(name ?? address.slice(0, 8));
        const byAddress = this.db.wallets
          .select()
          .where({ address })
          .first() as WalletRow | undefined;
        const byName = this.db.wallets
          .select()
          .where({ name: resolvedName })
          .first() as WalletRow | undefined;
        const existing = byAddress ?? byName;
        if (existing) {
          existing.name = resolvedName;
          existing.address = address;
          existing.encryptedSecretKey = encrypted.encryptedSecretKey;
          existing.nonce = encrypted.nonce;
          existing.authTag = encrypted.authTag;
          existing.isActive = 1;
          existing.updatedAtMs = Date.now();
          return existing;
        }
        const now = Date.now();
        return this.db.wallets.insert({
          name: resolvedName,
          address,
          ...encrypted,
          isActive: 1,
          createdAtMs: now,
          updatedAtMs: now,
        }) as WalletRow;
      },
      walletLog,
    );
  }

  list(): WalletRow[] {
    return this.db.wallets
      .select()
      .where({ isActive: 1 })
      .orderBy("id", "asc")
      .all() as WalletRow[];
  }

  resolve(ref: WalletRef): {
    address: PublicKey;
    row?: WalletRow;
    signer?: Keypair;
  } {
    if (ref instanceof Keypair) return { address: ref.publicKey, signer: ref };
    if (ref instanceof PublicKey) {
      const row = this.db.wallets
        .select()
        .where({ address: ref.toBase58() })
        .first() as WalletRow | undefined;
      return row ? { address: ref, row } : { address: ref };
    }
    if (typeof ref !== "string")
      return { address: new PublicKey(ref.address), row: ref };
    const value = clean(ref);
    const address = maybeAddress(value);
    const row = (
      address
        ? this.db.wallets.select().where({ address }).first()
        : this.db.wallets.select().where({ name: value }).first()
    ) as WalletRow | undefined;
    if (!row) throw new UnknownWalletError(ref);
    return { address: new PublicKey(row.address), row };
  }

  signer(ref: WalletRef): {
    address: PublicKey;
    row?: WalletRow;
    signer: Keypair;
  } {
    const resolved = this.resolve(ref);
    if (resolved.signer) return { ...resolved, signer: resolved.signer };
    if (!resolved.row)
      throw new WalletCannotSignError(resolved.address.toBase58());
    const signer = decryptKeypair(resolved.row);
    return { address: signer.publicKey, row: resolved.row, signer };
  }
}
