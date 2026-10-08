import { expect, test } from "bun:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Solard } from "./solard.ts";
import { isDefinitivePreSubmissionError } from "./errors.ts";
import { TradePreSubmissionError } from "../tx/trade-errors.ts";

test("confirmed custom-quote fills separate SOL principal, network fees and rent from target deltas", async () => {
  const directory = mkdtempSync(join(tmpdir(), "solard-fill-"));
  const slrd = new Solard({ dbPath: join(directory, "test.sqlite") });
  const owner = new PublicKey("4jxDfXDLRh3fJvQxPhuV5uMt4YLEsaM6QNYFuMddbCen");
  const mint = new PublicKey("3yLHGEma4ek25h8oRswBmYTJkTDdtGnrVn2ZuzV5pump");
  const quoteMint = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
  const tokenBalance = (
    accountIndex: number,
    tokenMint: string,
    amount: string,
  ) => ({
    accountIndex,
    mint: tokenMint,
    owner: owner.toBase58(),
    uiTokenAmount: { amount, decimals: 6 },
  });
  slrd.connection = () =>
    ({
      async getTransaction(signature: string) {
        const buy = signature === "routed-buy";
        return {
          blockTime: 1_790_000_000,
          transaction: {
            message: { accountKeys: [owner, PublicKey.default, mint] },
          },
          meta: {
            err: null,
            fee: buy ? 125_000 : 65_000,
            preBalances: buy
              ? [500_000_000, 0, 2_000_000]
              : [500_000_000, 2_000_000, 2_000_000],
            postBalances: buy
              ? [496_875_000, 2_000_000, 2_000_000]
              : [502_935_000, 0, 2_000_000],
            preTokenBalances: [
              tokenBalance(2, quoteMint, "500000000"),
              ...(buy ? [] : [tokenBalance(1, mint.toBase58(), "12000000")]),
            ],
            postTokenBalances: [
              tokenBalance(2, quoteMint, buy ? "500001000" : "500000000"),
              ...(buy ? [tokenBalance(1, mint.toBase58(), "12000000")] : []),
            ],
          },
        };
      },
    }) as unknown as Connection;
  try {
    const bought = await slrd.recordConfirmedTrade({
      wallet: owner,
      token: mint,
      signature: "routed-buy",
      side: "buy",
    });
    expect(bought.solDeltaLamports).toBe(-1_000_000n);
    expect(bought.tokenDeltaRaw).toBe(12_000_000n);
    expect(bought.networkFeeLamports).toBe(125_000n);
    const sold = await slrd.recordConfirmedTrade({
      wallet: owner,
      token: mint,
      signature: "routed-sell",
      side: "sell",
    });
    expect(sold.solDeltaLamports).toBe(1_000_000n);
    expect(sold.tokenDeltaRaw).toBe(-12_000_000n);
    expect(sold.networkFeeLamports).toBe(65_000n);
  } finally {
    slrd.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pre-submission route/configuration failures are distinguishable from ambiguous transport errors", () => {
  const error = new TradePreSubmissionError(
    new Error("No SOL funding market for this quote token"),
  );
  expect(error.phase).toBe("before-submission");
  expect(isDefinitivePreSubmissionError(error)).toBe(true);
  expect(
    isDefinitivePreSubmissionError(new Error("RPC wait exceeded 5000ms")),
  ).toBe(false);
});
