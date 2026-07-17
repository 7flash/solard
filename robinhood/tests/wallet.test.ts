import { describe, expect, test } from "bun:test";
import { activitiesFromBlock } from "../src/wallet-tracker.ts";
import { addressTopic, TRANSFER_TOPIC } from "../src/shared/evm.ts";

describe("wallet flow", () => {
  test("classifies token purchase from native value", () => {
    const wallet = "0x1111111111111111111111111111111111111111";
    const token = "0x2222222222222222222222222222222222222222";
    const pool = "0x3333333333333333333333333333333333333333";
    const activities = activitiesFromBlock(
      {
        header: { number: 10, hash: "0xblock" },
        transactions: [
          {
            transactionIndex: 0,
            hash: "0xtx",
            from: wallet,
            to: pool,
            value: "1000",
            gasUsed: "10",
            gasPrice: "2",
            status: 1,
          },
        ],
        logs: [
          {
            address: token,
            topics: [TRANSFER_TOPIC, addressTopic(pool), addressTopic(wallet)],
            data: "0x64",
            transactionHash: "0xtx",
            transactionIndex: 0,
            logIndex: 0,
          },
        ],
      },
      new Set([wallet]),
    );
    expect(activities).toHaveLength(1);
    expect(activities[0]?.kind).toBe("BUY");
    expect(activities[0]?.nativeDeltaWei).toBe(-1020n);
    expect(activities[0]?.tokenDeltas[0]?.amount).toBe(100n);
  });
});
