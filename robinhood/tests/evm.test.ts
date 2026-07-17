import { describe, expect, test } from "bun:test";
import {
  addressTopic,
  decodeTransfer,
  scaledUiAmount,
  TRANSFER_TOPIC,
} from "../src/shared/evm.ts";

describe("EVM helpers", () => {
  test("decodes ERC-20 transfer", () => {
    const from = "0x1111111111111111111111111111111111111111";
    const to = "0x2222222222222222222222222222222222222222";
    const decoded = decodeTransfer({
      address: "0x3333333333333333333333333333333333333333",
      topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(to)],
      data: "0x64",
      transactionHash: "0xabc",
      logIndex: 7,
      transactionIndex: 2,
    });
    expect(decoded?.from).toBe(from);
    expect(decoded?.to).toBe(to);
    expect(decoded?.amount).toBe(100n);
  });

  test("applies ERC-8056 multiplier", () => {
    expect(scaledUiAmount(50n * 10n ** 18n, 2n * 10n ** 18n)).toBe(
      100n * 10n ** 18n,
    );
  });
});
