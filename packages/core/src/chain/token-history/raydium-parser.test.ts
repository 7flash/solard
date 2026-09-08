import { describe, expect, test } from "bun:test";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { parseRaydiumHistoryTransaction } from "./raydium-parser.ts";

const WALLET = "11111111111111111111111111111111";
const MINT = "So11111111111111111111111111111111111111111";

function tx(args: { buy: boolean }): ParsedTransactionWithMeta {
  const beforeToken = args.buy ? "0" : "100000000";
  const afterToken = args.buy ? "100000000" : "0";
  return {
    slot: 123,
    blockTime: 1_700_000_000,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1_000_000_000, 2_039_280],
      postBalances: [args.buy ? 899_995_000 : 1_099_995_000, 2_039_280],
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: MINT,
          owner: WALLET,
          uiTokenAmount: {
            amount: beforeToken,
            decimals: 6,
            uiAmount: null,
            uiAmountString: "",
          },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: MINT,
          owner: WALLET,
          uiTokenAmount: {
            amount: afterToken,
            decimals: 6,
            uiAmount: null,
            uiAmountString: "",
          },
        },
      ],
      innerInstructions: [],
      logMessages: [],
      postBalances: [args.buy ? 899_995_000 : 1_099_995_000, 2_039_280],
      preBalances: [1_000_000_000, 2_039_280],
      rewards: [],
      loadedAddresses: { writable: [], readonly: [] },
      computeUnitsConsumed: 0,
    } as any,
    transaction: {
      signatures: ["sig"],
      message: {
        accountKeys: [
          { pubkey: { toBase58: () => WALLET }, signer: true, writable: true },
          {
            pubkey: {
              toBase58: () => "TokenAccount11111111111111111111111111111",
            },
            signer: false,
            writable: true,
          },
        ],
        instructions: [],
        recentBlockhash: "hash",
      } as any,
    },
    version: 0,
  } as any;
}

describe("parseRaydiumHistoryTransaction", () => {
  test("derives effective SOL spend after removing network fee", () => {
    const result = parseRaydiumHistoryTransaction({
      tx: tx({ buy: true }),
      signature: "sig-buy",
      mint: MINT,
      decimals: 6,
      supplyUi: 1_000_000,
      historyOrder: 0,
      scanAddress: "pool",
      confidence: "finalized",
    });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.side).toBe("buy");
    expect(result.trades[0]!.solDeltaUi).toBeCloseTo(0.1, 9);
    expect(result.trades[0]!.tokenDeltaUi).toBeCloseTo(100, 9);
  });

  test("derives effective SOL proceeds on sell", () => {
    const result = parseRaydiumHistoryTransaction({
      tx: tx({ buy: false }),
      signature: "sig-sell",
      mint: MINT,
      decimals: 6,
      supplyUi: 1_000_000,
      historyOrder: 0,
      scanAddress: "pool",
      confidence: "finalized",
    });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.side).toBe("sell");
    expect(result.trades[0]!.solDeltaUi).toBeCloseTo(0.1, 9);
  });
});
