import { describe, expect, test } from "bun:test";
import {
  aggregateHolderDeltas,
  classifyHolderChange,
} from "../src/holder-tracker.js";

describe("holder aggregation", () => {
  test("aggregates several token accounts by owner", () => {
    const rows = [
      {
        transactionIndex: 0,
        preMint: "M",
        postMint: "M",
        preOwner: "A",
        postOwner: "A",
        preAmount: "10",
        postAmount: "15",
      },
      {
        transactionIndex: 0,
        preMint: "M",
        postMint: "M",
        preOwner: "A",
        postOwner: "A",
        preAmount: "20",
        postAmount: "18",
      },
    ];

    expect(aggregateHolderDeltas(rows, new Set(["M"]))).toEqual([
      { mint: "M", owner: "A", delta: 3n },
    ]);
  });

  test("classifies transitions", () => {
    expect(classifyHolderChange(0n, 1n)).toBe("NEW_HOLDER");
    expect(classifyHolderChange(10n, 12n)).toBe("INCREASE");
    expect(classifyHolderChange(10n, 3n)).toBe("DECREASE");
    expect(classifyHolderChange(10n, 0n)).toBe("EXIT");
  });
});
