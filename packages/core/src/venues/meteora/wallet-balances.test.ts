import { expect, test } from "bun:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { MeteoraDlmmService } from "./dlmm.ts";

test("wallet balance helpers read public accounts without loading signers or DLMM", async () => {
  const commitments: unknown[] = [];
  const service = new MeteoraDlmmService({
    walletAddress: () => PublicKey.default,
    signer: () => { throw new Error("Unexpected signer access"); },
    connection: () => ({
      getBalance: async (_owner: unknown, commitment: unknown) => {
        commitments.push(commitment); return 1_500_000_000;
      },
      getParsedTokenAccountsByOwner: async (_owner: unknown, _filter: unknown, options: unknown) => {
        commitments.push(options);
        return { value: ["9007199254740993", "7"].map(amount => ({ account: {
          data: { parsed: { info: { tokenAmount: { amount } } } },
        } })) };
      },
    }) as unknown as Connection,
  });
  expect(await service.getWalletNativeBalance("public", "finalized")).toEqual({
    wallet: PublicKey.default.toBase58(), lamports: "1500000000", sol: 1.5,
  });
  expect((await service.getWalletTokenBalance("public", PublicKey.default.toBase58(), "finalized")).rawAmount)
    .toBe("9007199254741000");
  expect(commitments).toEqual(["finalized", { commitment: "finalized" }]);
});
