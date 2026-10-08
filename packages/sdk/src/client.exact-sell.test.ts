import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Solard } from "../../core/src/core/solard.ts";
import { tradeResult } from "../../core/src/tx/trade-result.ts";
import { createSolard, type SolardSellInput } from "./client.ts";
import { isDefinitivePreSubmissionError } from "@solard/core";

test("SDK exact raw sell forwards an isolated position without inserting default bps", async () => {
  const folder = mkdtempSync(join(tmpdir(), "solard-sdk-exact-"));
  const calls: Array<Record<string, unknown>> = [];
  const sell = spyOn(Solard.prototype, "sell").mockImplementation(
    async (_token, _wallet, options) => {
      calls.push(options as unknown as Record<string, unknown>);
      return tradeResult({
        signature: "fixture",
        sender: "rpc",
        status: "confirmed",
        slot: 1,
      });
    },
  );
  const sdk = createSolard({ dbPath: join(folder, "test.sqlite") });
  try {
    await sdk.sell(
      {
        token: "mint",
        wallet: "wallet",
        amountRaw: "284725",
        slippageBps: 500,
        minOutputLamports: 1n,
      },
      { priorityFee: { microLamports: 20_000 } },
    );
    await sdk.sell({
      token: "mint",
      wallet: "wallet",
      amount: { raw: 284725n },
    });
    await sdk.sell({ token: "mint", wallet: "wallet", amount: { bps: 1000 } });
    await sdk.sell({ token: "mint", wallet: "wallet", amount: "all" });
    expect(calls[0]).toMatchObject({
      amountRaw: "284725",
      slippageBps: 500,
      minOutputLamports: 1n,
      priorityFee: { microLamports: 20_000 },
    });
    expect(calls[0]?.bps).toBeUndefined();
    expect(calls[1]?.amountRaw).toBe(284725n);
    expect(calls[1]?.bps).toBeUndefined();
    expect(calls[2]?.bps).toBe(1000);
    expect(calls[3]?.bps).toBe(10000);
  } finally {
    sdk.close();
    sell.mockRestore();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("SDK rejects ambiguous and invalid raw quantities before invoking core sell", async () => {
  const folder = mkdtempSync(join(tmpdir(), "solard-sdk-exact-invalid-"));
  const sell = spyOn(Solard.prototype, "sell").mockImplementation(async () => {
    throw new Error("must not call core");
  });
  const sdk = createSolard({ dbPath: join(folder, "test.sqlite") });
  try {
    for (const size of [
      { amountRaw: "284725", amount: { bps: 1000 } },
      { amountRaw: 0n },
      { amountRaw: "1.5" },
      { amount: { raw: "-1" } },
      { amount: { bps: 1.5 } },
      { amount: { raw: "284725", bps: 1000 } },
    ]) {
      await expect(
        sdk.sell({
          token: "mint",
          wallet: "wallet",
          ...size,
        } as SolardSellInput),
      ).rejects.toThrow();
    }
    expect(sell).not.toHaveBeenCalled();
    try {
      await sdk.sell({ token: "mint", wallet: "wallet", amountRaw: 0n });
    } catch (error) {
      expect(isDefinitivePreSubmissionError(error)).toBe(true);
    }
  } finally {
    sdk.close();
    sell.mockRestore();
    rmSync(folder, { recursive: true, force: true });
  }
});
