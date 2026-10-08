import { expect, test } from "bun:test";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { Solard } from "./solard.ts";
import { TradePreSubmissionError } from "../tx/trade-errors.ts";
import { failedTrade } from "../tx/trade-result.ts";
import type { PlannedTransaction, TransactionDraft } from "../tx/types.ts";

function fixture(expected = "10000") {
  const slrd: Solard = Object.create(Solard.prototype);
  const payer = Keypair.generate();
  const draft: TransactionDraft = {
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: SystemProgram.programId,
        lamports: 5000,
      }),
    ],
    signers: [],
    trackedAccounts: [],
    cuLimit: 10000,
    cuPriceMicroLamports: 20000,
    actions: [
      {
        kind: "sell",
        meta: { expectedOutputRaw: expected, minOutputRaw: expected },
      },
      { kind: "landing-tip", meta: { lamports: 5000 } },
    ],
  };
  const plan = (value = draft): PlannedTransaction => {
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: SystemProgram.programId.toBase58(),
      instructions: value.instructions,
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    // Synthetic signature exercises the admission path without signing anything.
    transaction.signatures[0] = new Uint8Array(64).fill(1);
    return {
      transaction,
      draft: value,
      payer: payer.publicKey,
      lookupTables: [],
      recentBlockhash: message.recentBlockhash,
      lastValidBlockHeight: 100,
      serializedSize: transaction.serialize().length,
    };
  };
  const calls = {
    journal: 0,
    broadcast: 0,
    simulations: 0,
    computeLimits: [] as Array<number | undefined>,
  };
  const connection = {
    getBalance: async () => 1000000,
    getFeeForMessage: async () => ({ value: 5200 }),
  };
  slrd.connection = () => connection as any;
  slrd.signer = () => payer;
  slrd.compile = async (_payer, value) => {
    calls.computeLimits.push(value.cuLimit);
    return plan(value);
  };
  slrd.simulatePlan = async () => {
    calls.simulations++;
    return {
      success: true,
      cuUsed: 10000,
      logs: [],
      error: null,
      accountChanges: [],
      tokenChanges: [],
      solChanges: [],
    };
  };
  Object.defineProperty(slrd, "executions", {
    value: {
      findBySignature() {
        calls.journal++;
      },
      create() {
        calls.journal++;
        throw new Error("unexpected journal write");
      },
    },
  });
  Object.defineProperty(slrd, "senders", {
    value: {
      resolve() {
        return {
          send() {
            calls.broadcast++;
            throw new Error("unexpected broadcast");
          },
        };
      },
    },
  });
  return { slrd, plan: plan(), calls };
}

test("prepareTradePlan rejects uneconomic sell after simulation sizing and never journals or broadcasts", async () => {
  const value = fixture();
  let failure: unknown;
  try {
    await value.slrd.prepareTradePlan("fixture", value.plan, {
      computeUnits: "auto",
      priorityFee: { microLamports: 20000 },
    });
  } catch (error) {
    failure = error;
  }
  expect((failure as any).code).toBe("UNECONOMIC_SELL");
  expect((failure as any).networkFeeLamports).toBe(5260n);
  expect((failure as any).tipLamports).toBe(5000n);
  expect(value.calls.computeLimits).toEqual([10000, 13000]);
  expect(value.calls.simulations).toBe(1);
  expect(value.calls.journal).toBe(0);
  expect(value.calls.broadcast).toBe(0);
});

test("direct submitPlan rejects equality to selected RPC fee plus tip before journal and broadcast", async () => {
  const value = fixture("10200");
  let failure: unknown;
  try {
    await value.slrd.submitPlan(value.plan, "rpc", "sell", {
      skipSimulation: false,
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(TradePreSubmissionError);
  expect(failedTrade(failure)).toMatchObject({
    status: "failed",
    phase: "before-submission",
    code: "UNECONOMIC_SELL",
    sellEconomics: {
      expectedOutputLamports: 10200n,
      networkFeeLamports: 5200n,
      tipLamports: 5000n,
      requiredOutputLamports: 10201n,
    },
  });
  expect(value.calls.simulations).toBe(1);
  expect(value.calls.journal).toBe(0);
  expect(value.calls.broadcast).toBe(0);
});
