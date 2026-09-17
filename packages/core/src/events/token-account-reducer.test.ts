import { describe, expect, test } from "bun:test";

import { TOKEN_2022_ID } from "../venues/pump/constants.ts";
import { reduceTokenAccountTransaction } from "./token-account-reducer.ts";

const mint = "So11111111111111111111111111111111111111112";
const account = "11111111111111111111111111111111";
const owner = "SysvarRent111111111111111111111111111111111";
const otherProgram = {
  toBase58: () => "ComputeBudget111111111111111111111111111111",
};

describe("token account reducer read-only instructions", () => {
  test("ignores Token-2022 getAccountDataSize in CPI", () => {
    const tx = {
      slot: 10,
      blockTime: 1,
      transaction: {
        message: {
          accountKeys: [mint, account],
          instructions: [
            { programId: otherProgram },
            { programId: otherProgram },
            { programId: otherProgram },
          ],
        },
      },
      meta: {
        err: null,
        preTokenBalances: [
          {
            accountIndex: 1,
            mint,
            owner,
            uiTokenAmount: { amount: "100" },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint,
            owner,
            uiTokenAmount: { amount: "100" },
          },
        ],
        innerInstructions: [
          {
            index: 2,
            instructions: [
              {
                programId: TOKEN_2022_ID,
                parsed: {
                  type: "getAccountDataSize",
                  info: { mint, extensionTypes: ["immutableOwner"] },
                },
              },
            ],
          },
        ],
      },
    } as any;

    const reduced = reduceTokenAccountTransaction({
      tx,
      signature: "sig",
      mint,
      decimals: 9,
      confidence: "finalized",
      strict: true,
    });

    expect(reduced.events).toEqual([]);
    expect(reduced.accounts.get(account)?.amountRaw).toBe(100n);
    expect(reduced.ownerBalancesBefore.get(owner)).toBe(100n);
    expect(reduced.ownerBalancesAfter.get(owner)).toBe(100n);
  });
});
