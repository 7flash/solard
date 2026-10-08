import {
  createCloseAccountInstruction,
  createBurnCheckedInstruction,
  getTransferFeeAmount,
  unpackAccount,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { OwnedTokenAccount } from "./state.ts";
import type { TransactionDraft } from "../tx/types.ts";

export type TokenMaintenanceOptions = {
  keepMints?: readonly string[];
  batchSize?: number;
  /** Explicit per-mint upper bounds. Omitted means balances are never burned. */
  burnDust?: Readonly<Record<string, bigint>>;
};
export type TokenMaintenanceAccount = {
  address: string;
  mint: string;
  estimatedRentLamports: bigint;
  burnedRaw: bigint;
};
export type TokenMaintenanceBatch = {
  draft: TransactionDraft;
  accounts: Array<TokenMaintenanceAccount>;
};
export type TokenMaintenancePreparation = {
  batches: Array<TokenMaintenanceBatch>;
  skipped: Array<{ address: string; mint: string; reason: string }>;
};

/** Read-only planning. Nonempty accounts require an explicit dust ceiling before burning. */
export async function prepareTokenAccountMaintenance(
  connection: Connection,
  owner: PublicKey,
  accounts: readonly OwnedTokenAccount[],
  options: TokenMaintenanceOptions = {},
): Promise<TokenMaintenancePreparation> {
  const batchSize = options.batchSize ?? 12;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20)
    throw new Error("batchSize must be between 1 and 20");
  const keep = new Set(options.keepMints ?? []);
  const skipped: TokenMaintenancePreparation["skipped"] = [];
  const candidates = accounts.filter((account) => {
    const ceiling = options.burnDust?.[account.mint];
    if (ceiling != null && (typeof ceiling !== "bigint" || ceiling < 0n))
      throw new Error("Dust ceilings must be nonnegative raw bigint amounts");
    const reason = keep.has(account.mint)
      ? "KEPT_MINT"
      : account.owner !== owner.toBase58()
        ? "WRONG_OWNER"
        : account.amountRaw > 0n &&
            (ceiling == null || account.amountRaw > ceiling)
          ? "NONEMPTY"
          : account.amountRaw > 0n && account.mint === NATIVE_MINT.toBase58()
            ? "UNWRAP_NATIVE_INSTEAD"
            : null;
    if (reason)
      skipped.push({ address: account.address, mint: account.mint, reason });
    return reason == null;
  });
  const batches: Array<TokenMaintenanceBatch> = [];
  for (let start = 0; start < candidates.length; start += batchSize) {
    const rows = candidates.slice(start, start + batchSize);
    const infos = await connection.getMultipleAccountsInfo(
      rows.map((row) => new PublicKey(row.address)),
      "confirmed",
    );
    const batch: TokenMaintenanceBatch = {
      draft: {
        instructions: [],
        signers: [],
        actions: [],
        trackedAccounts: [{ address: owner, kind: "sol" }],
        cuLimit: 100_000,
      },
      accounts: [],
    };
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      const address = new PublicKey(row.address);
      const program = new PublicKey(row.tokenProgram);
      if (
        !program.equals(TOKEN_PROGRAM_ID) &&
        !program.equals(TOKEN_2022_PROGRAM_ID)
      )
        throw new Error("Unsupported token account program");
      const info = infos[index];
      if (!info) {
        skipped.push({
          address: row.address,
          mint: row.mint,
          reason: "ACCOUNT_MISSING",
        });
        continue;
      }
      const account = unpackAccount(address, info, program);
      const closeAuthority = account.closeAuthority ?? account.owner;
      const ceiling = options.burnDust?.[row.mint];
      const reason =
        !account.owner.equals(owner) ||
        !account.mint.equals(new PublicKey(row.mint))
          ? "IDENTITY_CHANGED"
          : !closeAuthority.equals(owner)
            ? "OTHER_CLOSE_AUTHORITY"
            : (getTransferFeeAmount(account)?.withheldAmount ?? 0n) > 0n
              ? "WITHHELD_FEES"
              : account.amount > 0n &&
                  (ceiling == null || account.amount > ceiling)
                ? "BALANCE_CHANGED"
                : account.amount > 0n && account.mint.equals(NATIVE_MINT)
                  ? "UNWRAP_NATIVE_INSTEAD"
                  : account.amount > 0n && account.isFrozen
                    ? "FROZEN_BALANCE"
                    : null;
      if (reason) {
        skipped.push({ address: row.address, mint: row.mint, reason });
        continue;
      }
      if (account.amount > 0n) {
        batch.draft.instructions.push(
          createBurnCheckedInstruction(
            address,
            account.mint,
            owner,
            account.amount,
            row.decimals,
            [],
            program,
          ),
        );
        batch.draft.actions.push({
          kind: "burn-dust",
          mint: account.mint,
          meta: {
            inputRaw: account.amount.toString(),
            tokenAccount: row.address,
          },
        });
      }
      batch.draft.instructions.push(
        createCloseAccountInstruction(address, owner, owner, [], program),
      );
      batch.draft.actions.push({
        kind: "close-token-account",
        mint: account.mint,
        meta: { tokenAccount: row.address },
      });
      batch.draft.trackedAccounts.push({
        address,
        kind: "token",
        mint: account.mint,
      });
      batch.accounts.push({
        address: row.address,
        mint: row.mint,
        estimatedRentLamports: BigInt(info.lamports),
        burnedRaw: account.amount,
      });
    }
    if (batch.accounts.length) batches.push(batch);
  }
  return { batches, skipped };
}
