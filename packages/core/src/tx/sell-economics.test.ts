import { expect, test } from "bun:test";
import {
  assertEconomicSell,
  selectedPriorityFeeLamports,
  UneconomicSellError,
} from "./sell-economics.ts";
import { TradePreSubmissionError } from "./trade-errors.ts";
import { failedTrade } from "./trade-result.ts";
import type { TransactionDraft } from "./types.ts";

function draft(...metas: Array<Record<string, unknown>>): TransactionDraft {
  return {
    instructions: [],
    signers: [],
    trackedAccounts: [],
    actions: metas.map((meta) => ({ kind: "sell", meta })),
  };
}

test("economic sell guard includes rounded reserved priority, actual selected base and tip", () => {
  const priority = selectedPriorityFeeLamports(10001, 100);
  expect(priority).toBe(2n);
  const network = 5000n + priority;
  const transaction = draft({
    expectedOutputRaw: "10002",
    minOutputRaw: "9000",
  });
  let failure: unknown;
  try {
    assertEconomicSell(transaction, {
      networkFeeLamports: network,
      tipLamports: 5000n,
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(UneconomicSellError);
  expect(failure).toMatchObject({
    code: "UNECONOMIC_SELL",
    expectedOutputLamports: 10002n,
    networkFeeLamports: 5002n,
    tipLamports: 5000n,
    requiredOutputLamports: 10003n,
    outputSource: "expected",
  });
  expect(
    assertEconomicSell(draft({ expectedOutputRaw: "10003" }), {
      networkFeeLamports: network,
      tipLamports: 5000n,
    })?.requiredOutputLamports,
  ).toBe(10003n);
});

test("grouped final SOL sell outputs count once; unrelated claims/transfers never subsidize them", () => {
  const transaction = draft(
    {
      expectedOutputRaw: "3000",
      minSolOutputRaw: "2000",
      guaranteedIntermediateRaw: "99999999999",
    },
    { expectedOutputRaw: "3000" },
  );
  transaction.actions.push(
    { kind: "claim", meta: { expectedOutputRaw: "999999" } },
    { kind: "transfer-sol", meta: { lamports: 999999 } },
  );
  expect(
    assertEconomicSell(transaction, { networkFeeLamports: 5000n })
      ?.expectedOutputLamports,
  ).toBe(6000n);
  expect(() =>
    assertEconomicSell(transaction, { networkFeeLamports: 7000n }),
  ).toThrow(UneconomicSellError);
  expect(
    assertEconomicSell(
      {
        ...transaction,
        actions: transaction.actions.filter((action) => action.kind !== "sell"),
      },
      { networkFeeLamports: 999999n },
    ),
  ).toBeNull();
});

test("missing expected output uses declared minimum conservatively; unavailable/foreign output is refused", () => {
  const transaction = draft({ minSolOutputRaw: "12000" });
  transaction.actions.push({ kind: "landing-tip", meta: { lamports: 5000 } });
  expect(
    assertEconomicSell(transaction, { networkFeeLamports: 5000 })?.outputSource,
  ).toBe("minimum");
  expect(
    assertEconomicSell(transaction, { networkFeeLamports: 5000 })?.tipLamports,
  ).toBe(5000n);
  expect(() =>
    assertEconomicSell(draft({}), { networkFeeLamports: 5000n }),
  ).toThrow("no expected or guaranteed");
  expect(() =>
    assertEconomicSell(
      draft({ expectedOutputRaw: "9000000", outputMint: "custom-quote" }),
      { networkFeeLamports: 5000n },
    ),
  ).toThrow("not native SOL");
  expect(() =>
    assertEconomicSell(draft({ expectedOutputRaw: "9000000" }), {
      networkFeeLamports: Number.NaN,
    }),
  ).toThrow("known nonnegative");
});

test("economic rejection survives nested causes and failed result keeps selected costs distinct from paid fees", () => {
  const original = new UneconomicSellError({
    expectedOutputLamports: 10n,
    networkFeeLamports: 5000n,
    tipLamports: 5000n,
    requiredOutputLamports: 10001n,
    outputSource: "minimum",
  });
  const wrapped = new TradePreSubmissionError(
    new Error("Preparation rejected", { cause: original }),
  );
  expect(wrapped.code).toBe("UNECONOMIC_SELL");
  expect((wrapped as any).expectedOutputLamports).toBe(10n);
  const result = failedTrade(wrapped);
  expect(result).toMatchObject({
    status: "failed",
    phase: "before-submission",
    code: "UNECONOMIC_SELL",
    retryable: false,
    sellEconomics: {
      expectedOutputLamports: 10n,
      networkFeeLamports: 5000n,
      tipLamports: 5000n,
      requiredOutputLamports: 10001n,
      outputSource: "minimum",
    },
  });
  expect(result.networkFeeLamports).toBeNull();
  expect(
    failedTrade(new Error("Outer", { cause: original })).sellEconomics
      ?.expectedOutputLamports,
  ).toBe(10n);
});
