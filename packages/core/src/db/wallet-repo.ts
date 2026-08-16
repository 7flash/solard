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

export type WalletInfo = Pick<
  WalletRow,
  "id" | "name" | "address" | "isActive" | "createdAtMs" | "updatedAtMs"
>;

function publicWallet(row: WalletRow): WalletInfo {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    isActive: row.isActive,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

export type WalletImportOptions = {
  /**
   * When this is true, it should or will allow replacing a different wallet that already uses the
   * requested name. Same address re-imports always update without this flag.
   */
  overwrite?: boolean;
};

export class WalletRepo {
  constructor(private readonly db: SolardDatabase) {}

  /** Generate a new Solana keypair and persist it encrypted in the canonical Solard DB. */
  create(name?: string): WalletInfo {
    return publicWallet(
      measuredSync(
        m,
        "create",
        () => this.persistKeypair(Keypair.generate(), name),
        walletLog,
      ),
    );
  }

  import(
    privateKey: string,
    name?: string,
    options: WalletImportOptions = {},
  ): WalletInfo {
    return publicWallet(
      measuredSync(
        m,
        "import",
        () => this.persistKeypair(parseKeypair(privateKey), name, options),
        walletLog,
      ),
    );
  }

  private persistKeypair(
    keypair: Keypair,
    name?: string,
    options: WalletImportOptions = {},
  ): WalletRow {
    const address = keypair.publicKey.toBase58();
    const encrypted = encryptKeypair(keypair);
    const resolvedName = clean(name ?? address.slice(0, 8));
    const byAddress = this.db.wallets.select().where({ address }).first() as
      WalletRow | undefined;
    const byName = this.db.wallets
      .select()
      .where({ name: resolvedName })
      .first() as WalletRow | undefined;

    // Name is held by a different address: refuse unless overwrite.
    if (byName && byName.address !== address) {
      if (!options.overwrite) {
        throw new Error(
          `Wallet name '${resolvedName}' is already used by ${byName.address}. ` +
            `Choose a different name, or pass overwrite/force to replace it.`,
        );
      }
    }

    const existing =
      byAddress ??
      (byName && (byName.address === address || options.overwrite)
        ? byName
        : undefined);

    if (existing) {
      this.db.wallets
        .update({
          name: resolvedName,
          address,
          encryptedSecretKey: encrypted.encryptedSecretKey,
          nonce: encrypted.nonce,
          authTag: encrypted.authTag,
          isActive: 1,
          updatedAtMs: Date.now(),
        })
        .where({ id: existing.id })
        .exec();
      const updated = this.db.wallets
        .select()
        .where({ id: existing.id })
        .first() as WalletRow | undefined;
      if (!updated) throw new Error(`Wallet update failed for ${resolvedName}`);
      return updated;
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
  }

  list(): WalletInfo[] {
    return (
      this.db.wallets
        .select()
        .where({ isActive: 1 })
        .orderBy("id", "asc")
        .all() as WalletRow[]
    ).map(publicWallet);
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
