import { describe, expect, test } from "bun:test";
import { createJupiterTransport } from "./jupiter-transport.ts";

const env = (values: Record<string, string>) => (name: string) => values[name];

describe("Jupiter transport", () => {
  test("requires an API key before network access", async () => {
    let calls = 0;
    const transport = createJupiterTransport({
      env: env({}),
      fetch: (async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    await expect(
      transport.fetchOrder({
        inputMint: "input",
        outputMint: "output",
        amountRaw: 1n,
      }),
    ).rejects.toThrow("JUPITER_API_KEY");
    expect(calls).toBe(0);
  });

  test("builds order requests and sends x-api-key", async () => {
    const requests: Array<{ url: string; key: string | null }> = [];
    const transport = createJupiterTransport({
      env: env({
        JUPITER_API_KEY: "test-key",
        SLRD_JUPITER_MAX_RPS: "100000",
      }),
      sleep: async () => {},
      now: () => 0,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(input),
          key: headers.get("x-api-key"),
        });
        return new Response(
          JSON.stringify({ outAmount: "123", router: "iris" }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    const order = await transport.fetchOrder({
      inputMint: "in-mint",
      outputMint: "out-mint",
      amountRaw: 42n,
      taker: "wallet",
    });

    expect(order.outAmount).toBe("123");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.key).toBe("test-key");
    expect(requests[0]!.url).toContain("inputMint=in-mint");
    expect(requests[0]!.url).toContain("outputMint=out-mint");
    expect(requests[0]!.url).toContain("amount=42");
    expect(requests[0]!.url).toContain("taker=wallet");
  });

  test("retries HTTP 429 with bounded retry policy", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const transport = createJupiterTransport({
      env: env({
        JUPITER_API_KEY: "test-key",
        SLRD_JUPITER_MAX_RPS: "100000",
        SLRD_JUPITER_429_RETRIES: "2",
      }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0,
      fetch: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("{}", {
            status: 429,
            headers: { "retry-after": "0.5" },
          });
        }
        return new Response(JSON.stringify({ outAmount: "1" }), {
          status: 200,
        });
      }) as typeof fetch,
    });

    await transport.fetchOrder({
      inputMint: "in",
      outputMint: "out",
      amountRaw: 1n,
    });

    expect(calls).toBe(2);
    expect(sleeps.some((value) => value >= 500)).toBe(true);
  });
});
