import { describe, expect, test } from "bun:test";

import { claimPhysicalId } from "./canonical-events.ts";

describe("canonical chain identity", () => {
  test("claim identity is independent of mint, recipient, and payout amount", () => {
    const first = claimPhysicalId({
      signature: "signature",
      positions: [{ instructionIndex: 2, innerInstructionIndex: 4 }],
    });
    const second = claimPhysicalId({
      signature: "signature",
      positions: [{ instructionIndex: 2, innerInstructionIndex: 4 }],
    });
    expect(first).toBe(second);
  });

  test("two physical claims to the same recipient in one transaction remain distinct", () => {
    const first = claimPhysicalId({
      signature: "signature",
      positions: [{ instructionIndex: 2, innerInstructionIndex: 4 }],
    });
    const second = claimPhysicalId({
      signature: "signature",
      positions: [{ instructionIndex: 2, innerInstructionIndex: 7 }],
    });
    expect(first).not.toBe(second);
  });
});
