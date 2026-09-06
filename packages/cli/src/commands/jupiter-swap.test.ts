import { describe, expect, test } from "bun:test";
import {
  jupiterCliAmountRaw,
  parseJupiterSwapCliRequest,
  type JupiterCliAsset,
} from "./jupiter-swap.ts";

function flags(entries: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(entries));
}

describe("Jupiter swap CLI parsing", () => {
  test("parses generic from/to syntax", () => {
    expect(
      parseJupiterSwapCliRequest(
        [],
        flags({
          from: "USDC",
          to: "SOL",
          amount: "90",
          wallet: "phantom",
        }),
      ),
    ).toEqual({
      wallet: "phantom",
      fromRef: "USDC",
      toRef: "SOL",
      amountUi: "90",
      live: false,
    });
  });

  test("preserves legacy SOL input syntax", () => {
    expect(
      parseJupiterSwapCliRequest(
        ["USDC"],
        flags({
          wallet: "phantom",
          sol: "1",
          live: "true",
        }),
      ),
    ).toEqual({
      wallet: "phantom",
      fromRef: "SOL",
      toRef: "USDC",
      amountUi: "1",
      live: true,
    });
  });

  test("rejects --sol with non-SOL --from", () => {
    expect(() =>
      parseJupiterSwapCliRequest(
        [],
        flags({
          wallet: "phantom",
          from: "USDC",
          to: "SOL",
          sol: "1",
        }),
      ),
    ).toThrow("--from SOL only");
  });

  test("uses canonical SOL amount parsing", () => {
    const solAsset: JupiterCliAsset = {
      ref: "SOL",
      kind: "sol",
      symbol: "SOL",
      mint: "So11111111111111111111111111111111111111112",
      decimals: 9,
      tokenProgram: null,
    };

    expect(jupiterCliAmountRaw(solAsset, "1.25")).toBe(1_250_000_000n);
  });
});
