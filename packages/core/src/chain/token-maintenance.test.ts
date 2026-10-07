import { expect, test } from "bun:test";
import { AccountLayout, ACCOUNT_SIZE, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import { prepareTokenAccountMaintenance } from "./token-maintenance.ts";
import type { OwnedTokenAccount } from "./state.ts";
const owner = new PublicKey("11111111111111111111111111111111");
const mint = new PublicKey("So11111111111111111111111111111111111111112");
const address = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const row: OwnedTokenAccount = { address: address.toBase58(), mint: mint.toBase58(), owner: owner.toBase58(), amountRaw: 0n,
  decimals: 9, tokenProgram: TOKEN_PROGRAM_ID.toBase58(), lamports: 2_039_280n, isAssociated: true, state: "initialized", closeAuthority: null };
function connection(amount = 0n, tokenMint = mint) {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({ mint: tokenMint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1,
    isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return { getMultipleAccountsInfo: async () => [{ data, owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, executable: false, rentEpoch: 0 }] } as unknown as Connection;
}
test("empty account maintenance builds real close instruction and honors kept mints", async () => {
  const result = await prepareTokenAccountMaintenance(connection(), owner, [row]);
  expect(result.batches[0]!.draft.instructions[0]!.data[0]).toBe(9);
  expect(result.batches[0]!.accounts[0]!.estimatedRentLamports).toBe(2_039_280n);
  expect((await prepareTokenAccountMaintenance(connection(), owner, [row], { keepMints: [row.mint] })).batches).toHaveLength(0);
});
test("dust is burned only under an explicit per-mint ceiling, then closed atomically", async () => {
  const tokenMint = new PublicKey("11111111111111111111111111111112");
  const dust = { ...row, mint: tokenMint.toBase58(), amountRaw: 2n, decimals: 6 };
  const result = await prepareTokenAccountMaintenance(connection(2n, tokenMint), owner, [dust], {burnDust: {[dust.mint]: 3n}});
  expect(result.batches[0]!.draft.instructions.map(item => item.data[0])).toEqual([15, 9]);
  expect(result.batches[0]!.accounts[0]!.burnedRaw).toBe(2n);
  expect((await prepareTokenAccountMaintenance(connection(2n, tokenMint), owner, [dust])).batches).toHaveLength(0);
});
test("a fresh nonempty balance is never closed or burned without an explicit ceiling", async () => {
  const changed = await prepareTokenAccountMaintenance(connection(1n), owner, [row]);
  expect(changed.batches).toHaveLength(0);
  expect(changed.skipped[0]!.reason).toBe("BALANCE_CHANGED");
  expect((await prepareTokenAccountMaintenance(connection(1n), owner, [{ ...row, amountRaw: 1n }], { burnDust: { [row.mint]: 5n } })).skipped[0]!.reason).toBe("UNWRAP_NATIVE_INSTEAD");
});
