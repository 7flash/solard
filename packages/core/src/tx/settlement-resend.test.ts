import { expect, spyOn, test } from "bun:test";
import type { Connection } from "@solana/web3.js";
import { Solard } from "../core/solard.ts";
import type { SendReceipt, SubmittedPlan } from "./types.ts";

function kernel(statuses: SendReceipt["status"][], expired = false) {
  const slrd: Solard = Object.create(Solard.prototype);
  const transaction = {} as SubmittedPlan["plan"]["transaction"];
  const sends: { sender: string; transaction: typeof transaction }[] = [];
  const checks: string[] = [];
  const updates: unknown[] = [];
  const slices: unknown[][] = [];
  const progress: string[] = [];
  let now = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  slrd.confirmSubmission = async (_submission, slice, rebroadcast) => {
    slices.push([slice, rebroadcast]);
    now += 1_500;
    return {
      signature: "original",
      sender: "helius-swqos",
      slot: null,
      status: statuses.shift() ?? "submitted",
    };
  };
  slrd.connection = () =>
    ({
      async getBlockHeight(commitment: string) {
        checks.push(commitment);
        return expired ? 101 : 99;
      },
      async getSignatureStatuses(_signatures: string[], options: unknown) {
        checks.push(`history:${JSON.stringify(options)}`);
        return { value: [null] };
      },
      async getTransaction(_signature: string, options: unknown) {
        checks.push(`transaction:${JSON.stringify(options)}`);
        return null;
      },
    }) as unknown as Connection;
  Object.defineProperty(slrd, "senders", {
    value: {
      resolve(sender: string) {
        return {
          async send(request: { transaction: typeof transaction }) {
            sends.push({ sender, transaction: request.transaction });
            return "original";
          },
        };
      },
    },
  });
  Object.defineProperty(slrd, "executions", {
    value: {
      get() {
        return {};
      },
      update(_row: unknown, value: unknown) {
        updates.push(value);
      },
    },
  });
  const submission = {
    signature: "original",
    sender: "helius-swqos",
    executionId: 1,
    plan: { transaction, lastValidBlockHeight: 100 },
    fallbackSenders: ["rpc"],
    onRebroadcast(signature: string) {
      progress.push(signature);
    },
  } as SubmittedPlan;
  return { slrd, submission, sends, checks, updates, progress, slices, clock };
}

test("valid submissions rebroadcast identical bytes through Sender and RPC until confirmed", async () => {
  const k = kernel(["submitted", "submitted", "confirmed"]);
  try {
    expect(
      await k.slrd.settleSubmission(k.submission, 1_000, 30_000, 1_500),
    ).toMatchObject({ status: "confirmed", signature: "original" });
    expect(k.sends.map((send) => send.sender)).toEqual([
      "helius-swqos",
      "rpc",
      "helius-swqos",
      "rpc",
    ]);
    for (const send of k.sends)
      expect(send.transaction).toBe(k.submission.plan.transaction);
    expect(k.progress).toEqual([
      "original",
      "original",
      "original",
      "original",
    ]);
    expect(k.slices).toEqual([
      [1_000, false],
      [1_000, false],
      [1_000, false],
    ]);
    expect(k.checks).toEqual(["confirmed", "confirmed"]);
    expect(k.updates).toHaveLength(0);
  } finally {
    k.clock.mockRestore();
  }
});

test("expired submissions stop sending only after healthy finalized history absence proof", async () => {
  const k = kernel(["submitted"], true);
  try {
    expect(await k.slrd.settleSubmission(k.submission)).toMatchObject({
      status: "failed",
      retryable: true,
    });
    expect(k.sends).toHaveLength(0);
    expect(k.progress).toHaveLength(0);
    expect(k.checks).toEqual([
      "confirmed",
      "finalized",
      'history:{"searchTransactionHistory":true}',
      'transaction:{"commitment":"confirmed","maxSupportedTransactionVersion":1}',
    ]);
    expect(k.updates).toHaveLength(1);
    expect(k.updates[0]).toMatchObject({ status: "failed" });
  } finally {
    k.clock.mockRestore();
  }
});

test("invalid confirmation options fail before building or submitting", async () => {
  const slrd: Solard = Object.create(Solard.prototype);
  let builds = 0;
  let submissions = 0;
  slrd.submitPlan = async () => {
    submissions++;
    throw new Error("must not submit");
  };
  for (const confirm of [
    { resendIntervalMs: 500 },
    { pollIntervalMs: NaN },
    { timeoutMs: 0 },
  ]) {
    await expect(
      slrd.executeTradePlan(
        "fake",
        async () => {
          builds++;
          throw new Error("must not build");
        },
        "rpc",
        "buy",
        { confirm },
      ),
    ).rejects.toThrow("must be at least 1000ms");
  }
  expect(builds).toBe(0);
  expect(submissions).toBe(0);
});
