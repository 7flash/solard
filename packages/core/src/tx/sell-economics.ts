import { NATIVE_MINT } from "@solana/spl-token";
import type { TransactionDraft } from "./types.ts";

export type SellEconomics = {
  expectedOutputLamports: bigint;
  networkFeeLamports: bigint;
  tipLamports: bigint;
  requiredOutputLamports: bigint;
  outputSource: "expected" | "minimum" | "mixed";
};
export class UneconomicSellError extends Error {
  readonly code = "UNECONOMIC_SELL";
  readonly retryable = false;
  readonly expectedOutputLamports: bigint;
  readonly networkFeeLamports: bigint;
  readonly tipLamports: bigint;
  readonly requiredOutputLamports: bigint;
  readonly outputSource: SellEconomics["outputSource"];
  constructor(economics: SellEconomics) {
    super(
      `Sell output ${economics.expectedOutputLamports} lamports does not exceed selected network fee ${economics.networkFeeLamports} plus tip ${economics.tipLamports}; at least ${economics.requiredOutputLamports} lamports is required.`,
    );
    this.name = "UneconomicSellError";
    Object.assign(this, economics);
    this.expectedOutputLamports = economics.expectedOutputLamports;
    this.networkFeeLamports = economics.networkFeeLamports;
    this.tipLamports = economics.tipLamports;
    this.requiredOutputLamports = economics.requiredOutputLamports;
    this.outputSource = economics.outputSource;
  }
}
export class SellEconomicsUnavailableError extends Error {
  readonly code = "SELL_ECONOMICS_UNAVAILABLE";
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "SellEconomicsUnavailableError";
  }
}
function lamports(value: unknown, label: string): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new SellEconomicsUnavailableError(
    `${label} must be a known nonnegative integer lamport amount`,
  );
}

/** Reserved CU pricing, never consumed-CU pricing. Integer ceiling prevents underquoting. */
export function selectedPriorityFeeLamports(
  cuLimit: number,
  priorityMicroLamports: number,
): bigint {
  if (
    !Number.isSafeInteger(cuLimit) ||
    cuLimit <= 0 ||
    !Number.isSafeInteger(priorityMicroLamports) ||
    priorityMicroLamports < 0
  )
    throw new SellEconomicsUnavailableError(
      "Selected compute limit/price is invalid",
    );
  return (BigInt(cuLimit) * BigInt(priorityMicroLamports) + 999999n) / 1000000n;
}

/**
 * Composer sell actions record FINAL native SOL output, including custom-quote
 * exit legs. Other actions (claims/transfers/buys/rent refunds) cannot subsidize
 * the guard. Re-evaluate after every attempt's final compute/fee/tip selection.
 */
export function assertEconomicSell(
  draft: TransactionDraft,
  costs: { networkFeeLamports: bigint | number; tipLamports?: bigint | number },
): SellEconomics | null {
  const sells = draft.actions.filter((action) => action.kind === "sell");
  if (!sells.length) return null;
  const networkFeeLamports = lamports(
    costs.networkFeeLamports,
    "Selected network fee",
  );
  let tipLamports =
    costs.tipLamports === undefined
      ? 0n
      : lamports(costs.tipLamports, "Selected landing tip");
  if (costs.tipLamports === undefined)
    for (const action of draft.actions)
      if (action.kind === "landing-tip")
        tipLamports += lamports(
          action.meta?.lamports ?? action.meta?.tipLamports,
          "Landing tip action",
        );
  let expectedOutputLamports = 0n;
  const sources = new Set<"expected" | "minimum">();
  for (const action of sells) {
    const meta = action.meta ?? {};
    if (
      meta.outputMint != null &&
      String(meta.outputMint) !== NATIVE_MINT.toBase58()
    )
      throw new SellEconomicsUnavailableError(
        "Sell action output is not native SOL; its output cannot be compared with SOL fees",
      );
    const expected = meta.expectedSolOutputLamports ?? meta.expectedOutputRaw;
    const minimum = meta.minSolOutputRaw ?? meta.minOutputRaw;
    if (expected !== undefined && expected !== null) {
      expectedOutputLamports += lamports(expected, "Expected final SOL output");
      sources.add("expected");
    } else if (minimum !== undefined && minimum !== null) {
      expectedOutputLamports += lamports(
        minimum,
        "Guaranteed final SOL output",
      );
      sources.add("minimum");
    } else
      throw new SellEconomicsUnavailableError(
        "Sell action has no expected or guaranteed final SOL output; economic viability is unavailable",
      );
  }
  const economics: SellEconomics = {
    expectedOutputLamports,
    networkFeeLamports,
    tipLamports,
    requiredOutputLamports: networkFeeLamports + tipLamports + 1n,
    outputSource:
      sources.size > 1
        ? "mixed"
        : sources.has("expected")
          ? "expected"
          : "minimum",
  };
  if (expectedOutputLamports < economics.requiredOutputLamports)
    throw new UneconomicSellError(economics);
  return economics;
}
