import {
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import type { AccountCache } from "./account-cache.ts";

export async function resolveTokenProgram(
  connection: Connection,
  mint: PublicKey,
  cache?: AccountCache,
): Promise<PublicKey> {
  return await (cache?.get(`mint-owner:${mint.toBase58()}`, load) ?? load());
  async function load() {
    const account = await connection.getAccountInfo(mint, "confirmed");
    if (!account) throw new Error(`Mint account not found: ${mint.toBase58()}`);
    if (
      account.owner.equals(TOKEN_PROGRAM_ID) ||
      account.owner.equals(TOKEN_2022_PROGRAM_ID)
    )
      return account.owner;
    throw new Error(
      `Unsupported token program ${account.owner.toBase58()} for mint ${mint.toBase58()}`,
    );
  }
}

export async function readMint(
  connection: Connection,
  mint: PublicKey,
  cache?: AccountCache,
) {
  const tokenProgram = await resolveTokenProgram(connection, mint, cache);
  const info = await (cache?.get(`mint:${mint.toBase58()}`, () =>
    getMint(connection, mint, "confirmed", tokenProgram),
  ) ?? getMint(connection, mint, "confirmed", tokenProgram));
  return { tokenProgram, decimals: info.decimals, supply: info.supply };
}

export async function readTokenAmount(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  try {
    return (await getAccount(connection, ata, "confirmed", tokenProgram))
      .amount;
  } catch {
    return 0n;
  }
}

export type OwnedTokenAccount = {
  address: string;
  mint: string;
  owner: string;
  amountRaw: bigint;
  decimals: number;
  tokenProgram: string;
  lamports: bigint;
  isAssociated: boolean;
  state: string | null;
  closeAuthority: string | null;
};

/** Lists actual token accounts owned by a wallet across Token and Token-2022. */
export async function listOwnedTokenAccounts(
  connection: Connection,
  owner: PublicKey,
): Promise<OwnedTokenAccount[]> {
  const rows: OwnedTokenAccount[] = [];
  for (const tokenProgram of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const response = await connection.getParsedTokenAccountsByOwner(
      owner,
      { programId: tokenProgram },
      "confirmed",
    );
    for (const item of response.value) {
      const data = item.account.data;
      if (!(typeof data === "object" && data !== null && "parsed" in data))
        continue;
      const parsed = (data as { parsed?: { info?: Record<string, unknown> } })
        .parsed;
      const info = parsed?.info;
      if (!info) continue;
      const mintValue = info.mint;
      const ownerValue = info.owner;
      const tokenAmount = info.tokenAmount as
        { amount?: unknown; decimals?: unknown } | undefined;
      if (
        typeof mintValue !== "string" ||
        typeof ownerValue !== "string" ||
        typeof tokenAmount?.amount !== "string" ||
        typeof tokenAmount?.decimals !== "number"
      )
        continue;
      const mint = new PublicKey(mintValue);
      const associated = getAssociatedTokenAddressSync(
        mint,
        owner,
        false,
        tokenProgram,
      );
      rows.push({
        address: item.pubkey.toBase58(),
        mint: mint.toBase58(),
        owner: ownerValue,
        amountRaw: BigInt(tokenAmount.amount),
        decimals: tokenAmount.decimals,
        tokenProgram: tokenProgram.toBase58(),
        lamports: BigInt(item.account.lamports),
        isAssociated: item.pubkey.equals(associated),
        state: typeof info.state === "string" ? info.state : null,
        closeAuthority:
          typeof info.closeAuthority === "string" ? info.closeAuthority : null,
      });
    }
  }
  return rows;
}

export async function getAccountInfoRequired(
  connection: Connection,
  address: PublicKey,
): Promise<AccountInfo<Buffer>> {
  const account = await connection.getAccountInfo(address, "confirmed");
  if (!account) throw new Error(`Account not found: ${address.toBase58()}`);
  return account;
}
