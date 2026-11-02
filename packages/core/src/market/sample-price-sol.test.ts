import { expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { SOL_ASSET } from "../core/amounts.ts";
import { samplePriceInSol } from "./sample-price-sol.ts";

test("SMA samples retain actual quote identity while converting verified prices to SOL", async () => {
  const sample = { venue: "pumpswap", mint: PublicKey.default, quoteAsset: SOL_ASSET,
    priceQuotePerToken: 0.003, capturedAtMs: Date.now() };
  expect((await samplePriceInSol(sample, async () => { throw new Error("No conversion needed"); })).priceSol).toBe(0.003);
  const custom = { ...sample, quoteAsset: { ...SOL_ASSET, kind: "spl-token" as const } };
  const converted = await samplePriceInSol(custom, async (mint, decimals) => {
    expect(mint).toBe(custom.quoteAsset.mint.toBase58()); expect(decimals).toBe(9);
    return 0.0004;
  });
  expect(converted.priceSol).toBeCloseTo(0.0000012, 12);
  expect(converted.quoteAsset.kind).toBe("spl-token");
  expect(converted.priceQuotePerToken).toBe(0.003);
  for (const value of [null, 0, -1, NaN, Infinity])
    await expect(samplePriceInSol(custom, async () => value)).rejects.toMatchObject({ code: "CONVERSION_UNAVAILABLE" });
});
