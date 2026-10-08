import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { Solard } from "../../core/src/core/solard.ts";
import { TransactionComposer } from "../../core/src/tx/composer.ts";
import type {
  PlannedTransaction,
  TransactionDraft,
} from "../../core/src/tx/types.ts";
import { createSolard } from "./client.ts";

test("SDK buy rebuild and sell preserve custom fees in immediate submitted results", async () => {
  const directory = mkdtempSync(join(tmpdir(), "solard-sdk-fees-"));
  const drafts: Array<TransactionDraft> = [];
  // A sentinel plan is never compiled, signed, or broadcast in this test.
  const payer = Keypair.generate();
  const plan = { payer: payer.publicKey } as PlannedTransaction;
  const build = spyOn(
    TransactionComposer.prototype,
    "build",
  ).mockImplementation(async function (this: TransactionComposer) {
    drafts.push(this.snapshot());
    return { ...plan, draft: this.snapshot() };
  });
  const signer = spyOn(Solard.prototype, "signer").mockImplementation(
    () => payer,
  );
  const compile = spyOn(Solard.prototype, "compile").mockImplementation(
    async (_payer, draft) => ({ ...plan, draft }),
  );
  let submissions = 0;
  const submit = spyOn(Solard.prototype, "submitPlan").mockImplementation(
    async () => {
      submissions += 1;
      if (submissions === 1) {
        throw new Error("Simulation failed: BuySlippageBelowMinBaseAmountOut");
      }
      return {
        signature: "test-signature",
        sender: "rpc",
        executionId: 42,
        plan,
      };
    },
  );
  const settle = spyOn(Solard.prototype, "settleSubmission").mockImplementation(
    async () => {
      throw new Error("Immediate submission must not wait for confirmation");
    },
  );
  const sdk = createSolard({ dbPath: join(directory, "test.sqlite") });
  try {
    const options = {
      priorityFee: { cuLimit: 300_000, microLamports: 0 },
      waitForConfirmation: false,
    };
    const buy = await sdk.buy(
      { token: "token", wallet: "wallet", amount: 0.1 },
      options,
    );
    const sell = await sdk.sell({ token: "token", wallet: "wallet" }, options);
    expect(drafts).toHaveLength(3);
    for (const draft of drafts) {
      expect(draft.cuLimit).toBe(300_000);
      expect(draft.cuPriceMicroLamports).toBe(0);
    }
    expect(buy.status).toBe("unresolved");
    expect(sell.status).toBe("unresolved");
    expect(buy.executionId).toBe(42);
    expect(settle).not.toHaveBeenCalled();
  } finally {
    sdk.close();
    build.mockRestore();
    signer.mockRestore();
    compile.mockRestore();
    submit.mockRestore();
    settle.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
