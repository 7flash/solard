import { expect, test } from "bun:test";
import { assertTradePrice, PriceGuardRejected, minimumBuyOutputForPrice, minimumSellOutputForPrice } from "./price-guard.ts";

test("minimum sell price becomes a ceiling-rounded SOL instruction floor", () => {
  expect(minimumSellOutputForPrice(1_000_000_000n, 6, "0.0001")).toBe(100_000_000n);
  const price = "0.0000000000001";
  const minimum = minimumSellOutputForPrice(1n, 6, price);
  expect(minimum).toBe(1n);
  expect(() => assertTradePrice("sell", 1n, minimum, 6, price)).not.toThrow();
  for (const value of ["0", "true", "-1", "1e999999"])
    expect(() => minimumSellOutputForPrice(1n, 6, value)).toThrow();
});

test("maximum buy price becomes an exact ceiling-rounded token instruction floor", () => {
  expect(minimumBuyOutputForPrice(100_000_000n, 6, "0.0001")).toBe(1_000_000_000n);
  const price = "0.000999999999999999999";
  const minimum = minimumBuyOutputForPrice(1n, 6, price);
  expect(minimum).toBe(2n);
  expect(() => assertTradePrice("buy", 1n, minimum, 6, price)).not.toThrow();
  expect(() => assertTradePrice("buy", 1n, minimum - 1n, 6, price)).toThrow();
  for (const value of ["0", "true", "-1", "1e999999"])
    expect(() => minimumBuyOutputForPrice(1n, 6, value)).toThrow();
  expect(() => minimumBuyOutputForPrice(1n, 6, "1e-300")).toThrow("u64");
});

test("buy guards use guaranteed tokens and exact decimal prices", () => {
  // 0.1 SOL buys at least 1000 whole tokens (six decimals).
  expect(() =>
    assertTradePrice("buy", 100_000_000n, 1_000_000_000n, 6, "0.0001"),
  ).not.toThrow();
  expect(() =>
    assertTradePrice("buy", 100_000_000n, 999_999_999n, 6, "0.0001"),
  ).toThrow(PriceGuardRejected);
  expect(() => assertTradePrice("buy", 1n, 1n, 6, "1e-3")).not.toThrow();
  expect(() =>
    assertTradePrice("buy", 1n, 1n, 6, "0.000999999999999999999"),
  ).toThrow(PriceGuardRejected);
});

test("sell guards use guaranteed SOL principal output", () => {
  expect(() =>
    assertTradePrice("sell", 1_000_000_000n, 100_000_000n, 6, 0.0001),
  ).not.toThrow();
  expect(() =>
    assertTradePrice("sell", 1_000_000_000n, 99_999_999n, 6, 0.0001),
  ).toThrow(PriceGuardRejected);
  try {
    assertTradePrice("sell", 1n, 0n, 6, "0.1");
  } catch (error) {
    expect(error).toMatchObject({
      code: "PRICE_GUARD_REJECTED",
      phase: "before-submission",
      retryable: true,
    });
  }
});

test("guards require verified decimals and valid positive price", () => {
  expect(() => assertTradePrice("buy", 1n, 1n, null, "1")).toThrow("Verified");
  for (const value of ["0", "-1", "NaN", Infinity, "1e999999"])
    expect(() => assertTradePrice("buy", 1n, 1n, 6, value)).toThrow();
  expect(() => assertTradePrice("buy", 1n, 0n, null)).not.toThrow();
});
