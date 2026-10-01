import { describe, expect, test } from "bun:test";
import { deriveWebSocketEndpoint, redactRpcEndpoint } from "./live.ts";

describe("sdk live endpoint", () => {
  test("derives websocket from the one RPC endpoint", () => {
    expect(
      deriveWebSocketEndpoint(
        "https://mainnet.helius-rpc.com/?api-key=secret-value",
      ),
    ).toBe("wss://mainnet.helius-rpc.com/?api-key=secret-value");
  });

  test("redacts API credentials in diagnostics", () => {
    expect(
      redactRpcEndpoint(
        "https://mainnet.helius-rpc.com/?api-key=secret-value&foo=bar",
      ),
    ).toBe("https://mainnet.helius-rpc.com/?api-key=<redacted>&foo=bar");
  });
});
