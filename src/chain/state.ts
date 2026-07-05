import {
  getAccount, getAssociatedTokenAddressSync, getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import type { AccountCache } from "./account-cache.js";

export async function resolveTokenProgram(connection: Connection, mint: PublicKey, cache?: AccountCache): Promise<PublicKey> {
  return await (cache?.get(`mint-owner:${mint.toBase58()}`, load) ?? load());
  async function load() {
    const account = await connection.getAccountInfo(mint, "confirmed");
    if (!account) throw new Error(`Mint account not found: ${mint.toBase58()}`);
    if (account.owner.equals(TOKEN_PROGRAM_ID) || account.owner.equals(TOKEN_2022_PROGRAM_ID)) return account.owner;
    throw new Error(`Unsupported token program ${account.owner.toBase58()} for mint ${mint.toBase58()}`);
  }
}

export async function readMint(connection: Connection, mint: PublicKey, cache?: AccountCache) {
  const tokenProgram = await resolveTokenProgram(connection, mint, cache);
  const info = await (cache?.get(`mint:${mint.toBase58()}`, () => getMint(connection, mint, "confirmed", tokenProgram)) ??
    getMint(connection, mint, "confirmed", tokenProgram));
  return { tokenProgram, decimals: info.decimals, supply: info.supply };
}

export async function readTokenAmount(connection: Connection, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  try { return (await getAccount(connection, ata, "confirmed", tokenProgram)).amount; } catch { return 0n; }
}

export async function getAccountInfoRequired(connection: Connection, address: PublicKey): Promise<AccountInfo<Buffer>> {
  const account = await connection.getAccountInfo(address, "confirmed");
  if (!account) throw new Error(`Account not found: ${address.toBase58()}`);
  return account;
}
