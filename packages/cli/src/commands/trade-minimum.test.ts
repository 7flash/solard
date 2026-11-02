import { expect, test } from "bun:test";
import { parseOutputMinimum } from "./trade-minimum.ts";
import { runSmartBuyCommand } from "./buy.ts";
import { runSmartSellCommand } from "./sell.ts";
import type { Solard } from "@solard/core";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
const mint = "E4R6KvcnxvoHYBe872byyCeoyExGHja8n5Vo3JNWodus";
test("absolute output parsing preserves precision and rejects ambiguous or unsafe input", () => {
  expect(parseOutputMinimum(new Map([["min-out", "123.000001"]]), 6)).toBe(123000001n);
  expect(parseOutputMinimum(new Map([["min-out", "0.001"]]), 9)).toBe(1000000n);
  expect(parseOutputMinimum(new Map([["min-out-raw", "9007199254740993"]]), 6)).toBe(9007199254740993n);
  for (const value of ["true", "0", "-1", "1e3", "0.0000001", "18446744073709551616"]) {
    expect(() => parseOutputMinimum(new Map([["min-out", value]]), 6)).toThrow();
  }
  expect(() => parseOutputMinimum(new Map([["min-out", "1"], ["slippage-bps", "100"]]), 6)).toThrow();
  expect(() => parseOutputMinimum(new Map([["min-out", "1"], ["min-out-raw", "1"]]), 6)).toThrow();
});
test("CLI buy/sell forward per-wallet absolute output floors in correct units", async () => {
  const seen: unknown[] = [];
  const host = {
    tokens: { list: () => [{ mint, decimals: 6, baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(), venueHint: "pumpswap" }] },
    buy: async (_mint: unknown, _wallet: unknown, _amount: unknown, options: unknown) => { seen.push(options); },
    sell: async (_mint: unknown, _wallet: unknown, options: unknown) => { seen.push(options); },
  } as unknown as Solard;
  await runSmartBuyCommand({ slrd: host, values: [mint], flags: new Map([["wallet", "test"], ["sol", "0.001"], ["min-out", "123.5"]]) });
  await runSmartSellCommand({ slrd: host, values: [mint], flags: new Map([["wallet", "test"], ["min-out", "0.001"]]) });
  expect(seen[0]).toMatchObject({ outputMinimumRaw: 123500000n });
  expect(seen[1]).toMatchObject({ outputMinimumRaw: 1000000n });
});
test("Jupiter absolute-floor requests fail explicitly without signing", async () => {
  const host = { tokens: { list: () => [] }, signer: () => { throw new Error("SIGNER_ACCESSED"); } } as unknown as Solard;
  await expect(runSmartBuyCommand({ slrd: host, values: ["USDC"],
    flags: new Map([["wallet", "test"], ["sol", "0.001"], ["min-out", "1"]]),
  })).rejects.toThrow("verified on-chain minimum");
});
test("maximum buy price derives the on-chain floor and combines with stricter token minima", async () => {
  const seen: unknown[] = [];
  const host = {
    tokens: { list: () => [{ mint, decimals: 6, baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(), venueHint: "pumpswap" }] },
    buy: async (_mint: unknown, _wallet: unknown, _amount: unknown, options: unknown) => { seen.push(options); },
  } as unknown as Solard;
  const flags = new Map([["wallet", "test"], ["sol", "0.1"], ["max-price-sol", "0.0001"]]);
  await runSmartBuyCommand({ slrd: host, values: [mint], flags });
  expect(seen[0]).toMatchObject({ maxPriceSol: "0.0001", outputMinimumRaw: 1000000000n });
  flags.set("min-out", "1100");
  await runSmartBuyCommand({ slrd: host, values: [mint], flags });
  expect(seen[1]).toMatchObject({ outputMinimumRaw: 1100000000n });
  flags.delete("min-out"); flags.set("slippage-bps", "100");
  await expect(runSmartBuyCommand({ slrd: host, values: [mint], flags })).rejects.toThrow("instead of");
});
