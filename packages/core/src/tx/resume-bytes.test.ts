import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import bs58 from "bs58";
import { Solard } from "../core/solard.ts";
import { openDatabase, closeDatabase } from "../db/database.ts";
import { TradeIntentStore } from "./trade-intent.ts";
import type { SubmittedPlan } from "./types.ts";

async function exercise(
  change: (meta: Record<string, unknown>) => void = () => {},
  finalStatus: "confirmed" | "submitted" = "confirmed",
) {
  const folder = mkdtempSync(join(tmpdir(), "solard-resume-bytes-"));
  const path = join(folder, "test.sqlite");
  try {
    const payer = PublicKey.default;
    const transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: PublicKey.default.toBase58(),
        instructions: [],
      }).compileToV0Message(),
    );
    // Synthetic public fixture bytes, never a cryptographic signature or private key.
    transaction.signatures[0] = new Uint8Array(64).fill(7);
    const signature = bs58.encode(transaction.signatures[0]!);
    const bytes = Buffer.from(transaction.serialize()).toString("base64");
    const meta: Record<string, unknown> = {
      signedTransactionBase64: bytes,
      recentBlockhash: transaction.message.recentBlockhash,
      lastValidBlockHeight: 100,
    };
    change(meta);
    let db = openDatabase(path);
    const store = new TradeIntentStore(db);
    store.claim("original-intent", "buy-fingerprint", payer.toBase58());
    store.update("original-intent", (intent) =>
      intent.submissions.push({
        signature,
        executionId: 1,
        sender: "helius-swqos",
        priorityMicroLamports: 20_000,
        lastValidBlockHeight: 100,
      }),
    );
    closeDatabase(path);
    db = openDatabase(path);
    const core: Solard = Object.create(Solard.prototype);
    Object.defineProperty(core, "db", { value: db });
    Object.defineProperty(core, "executions", {
      value: {
        get() {
          return { metaJson: JSON.stringify(meta) };
        },
      },
    });
    const restored: SubmittedPlan[] = [];
    let forbidden = 0;
    core.signer = () => {
      forbidden++;
      throw new Error("resume must not load keys");
    };
    core.compile = async () => {
      forbidden++;
      throw new Error("resume must not rebuild");
    };
    core.submitPlan = async () => {
      forbidden++;
      throw new Error("resume must not submit a new generation");
    };
    core.confirmSignature = async (original, sender) => ({
      signature: original,
      sender,
      status: "submitted",
      slot: null,
    });
    core.settleSubmission = async (submission) => {
      restored.push(submission);
      return {
        signature: submission.signature,
        sender: submission.sender,
        status: finalStatus,
        slot: finalStatus === "confirmed" ? 42 : null,
      };
    };
    core.connection = () =>
      ({
        async getBlockHeight() {
          return 99;
        },
      }) as unknown as Connection;
    const result = await core.resumeTrade("original-intent");
    expect(forbidden).toBe(0);
    expect(result.signature).toBe(signature);
    expect(
      new TradeIntentStore(db).get("original-intent")?.result?.status,
    ).toBe(result.status);
    return { result, restored, bytes, signature };
  } finally {
    closeDatabase(path);
    // folder is the exact directory freshly created above within OS temp.
    rmSync(folder, { recursive: true, force: true });
  }
}

test("restart resumes the exact journaled transaction without building or signing", async () => {
  const { result, restored, bytes, signature } = await exercise();
  expect(result).toMatchObject({ status: "confirmed", signature, slot: 42 });
  expect(restored).toHaveLength(1);
  expect(
    Buffer.from(restored[0]!.plan.transaction.serialize()).toString("base64"),
  ).toBe(bytes);
  expect(restored[0]!.plan.lastValidBlockHeight).toBe(100);
  expect(restored[0]!.sender).toBe("helius-swqos");
});

test("changed signature fixture retains uncertainty and never rebroadcasts", async () => {
  const { result, restored } = await exercise((meta) => {
    const altered = VersionedTransaction.deserialize(
      Buffer.from(String(meta.signedTransactionBase64), "base64"),
    );
    altered.signatures[0] = new Uint8Array(64).fill(8);
    meta.signedTransactionBase64 = Buffer.from(altered.serialize()).toString(
      "base64",
    );
  });
  expect(result).toMatchObject({
    status: "unresolved",
    code: "UNRESOLVED",
    retryable: false,
  });
  expect(restored).toHaveLength(0);
});

test("blockhash mismatch and malformed journal bytes remain unresolved", async () => {
  for (const change of [
    (meta: Record<string, unknown>) => {
      meta.recentBlockhash = "wrong-blockhash";
    },
    (meta: Record<string, unknown>) => {
      meta.signedTransactionBase64 = "not-a-transaction";
    },
  ]) {
    const { result, restored } = await exercise(change);
    expect(result).toMatchObject({
      status: "unresolved",
      code: "UNRESOLVED",
      retryable: false,
    });
    expect(restored).toHaveLength(0);
  }
});
