import { describe, expect, test } from "bun:test";
import { createJupiterSwapService } from "./jupiter-swap.ts";
import type { JupiterTransport } from "./jupiter-transport.ts";

function transportWithOrder(
  order: Awaited<ReturnType<JupiterTransport["fetchOrder"]>>,
): JupiterTransport {
  return {
    async fetchOrder() {
      return order;
    },
    async executeSignedTransaction() {
      throw new Error("not used");
    },
  };
}

describe("Jupiter swap service", () => {
  test("maps order response into an exact-input quote", async () => {
    const service = createJupiterSwapService(
      transportWithOrder({
        outAmount: "2500000",
        router: "iris",
        feeBps: 5,
        feeMint: "fee-mint",
      }),
    );

    const quote = await service.quote({
      inputMint: "input-mint",
      outputMint: "output-mint",
      amountRaw: 1_000_000n,
    });

    expect(quote).toEqual({
      inputMint: "input-mint",
      outputMint: "output-mint",
      amountRaw: 1_000_000n,
      outAmountRaw: 2_500_000n,
      router: "iris",
      feeBps: 5,
      feeMint: "fee-mint",
    });
  });

  test("rejects same-mint swaps before transport", async () => {
    let calls = 0;
    const service = createJupiterSwapService({
      async fetchOrder() {
        calls += 1;
        return { outAmount: "1" };
      },
      async executeSignedTransaction() {
        throw new Error("not used");
      },
    });

    await expect(
      service.quote({
        inputMint: "same",
        outputMint: "same",
        amountRaw: 1n,
      }),
    ).rejects.toThrow("must differ");
    expect(calls).toBe(0);
  });

  test("rejects zero-output routes", async () => {
    const service = createJupiterSwapService(
      transportWithOrder({ outAmount: "0", errorMessage: "no route" }),
    );

    await expect(
      service.quote({
        inputMint: "input",
        outputMint: "output",
        amountRaw: 1n,
      }),
    ).rejects.toThrow("no route");
  });
});
