import { describe, expect, test } from "bun:test";
import { classifyWalletActivity, WSOL } from "../src/wallet-tracker.js";

describe("wallet classification", () => {
  test("classifies one-token SOL buy", () => {
    const activity = classifyWalletActivity(
      "W",
      [{ mint: "TOKEN", delta: 1_000_000n, decimals: 6 }],
      -1_000_000_000n,
      5_000n,
    );
    expect(activity.kind).toBe("BUY");
  });

  test("folds wrapped SOL into SOL leg", () => {
    const activity = classifyWalletActivity(
      "W",
      [
        { mint: WSOL, delta: -2_000_000_000n, decimals: 9 },
        { mint: "TOKEN", delta: 1_000_000n, decimals: 6 },
      ],
      0n,
      5_000n,
    );
    expect(activity.kind).toBe("BUY");
    expect(activity.solDelta).toBe(-2_000_000_000n);
  });

  test("classifies token-to-token swap", () => {
    const activity = classifyWalletActivity(
      "W",
      [
        { mint: "A", delta: -10n, decimals: 6 },
        { mint: "B", delta: 20n, decimals: 6 },
      ],
      -5_000n,
      5_000n,
    );
    expect(activity.kind).toBe("SWAP");
  });

  test("does not pretend a multi-leg transaction is a simple buy", () => {
    const activity = classifyWalletActivity(
      "W",
      [
        { mint: "A", delta: 10n, decimals: 6 },
        { mint: "B", delta: 20n, decimals: 6 },
      ],
      -1_000_000_000n,
      5_000n,
    );
    expect(activity.kind).toBe("COMPOSITE");
  });
});
