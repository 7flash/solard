import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import { planRegistrySolSweep } from "./registry-sweep.ts";
import type { Solard } from "../core/solard.ts";

function fixture(
  sourceDataLength: number,
  sourceOwner = SystemProgram.programId,
) {
  const source = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;

  const slrd = {
    wallets: {
      list: () => [
        {
          name: "dev",
          address: source.toBase58(),
          isActive: true,
        },
      ],
    },
    groups: {
      list: () => [],
      wallets: () => [],
    },
    resolveWallet(ref: string) {
      if (ref === "dev" || ref === source.toBase58())
        return { address: source };
      throw new Error("unknown wallet");
    },
    connection() {
      return {
        async getMultipleAccountsInfo(keys: PublicKey[]) {
          return keys.map((key) =>
            key.equals(source)
              ? {
                  lamports: 1_000_000,
                  owner: sourceOwner,
                  executable: false,
                  rentEpoch: 0,
                  data: Buffer.alloc(sourceDataLength),
                }
              : null,
          );
        },
        async getLatestBlockhash() {
          return {
            blockhash: Keypair.generate().publicKey.toBase58(),
            lastValidBlockHeight: 1,
          };
        },
        async getFeeForMessage() {
          return { context: { slot: 1 }, value: 5_000 };
        },
      };
    },
  } as unknown as Solard;

  return { slrd, source, destination };
}

describe("registry SOL sweep source eligibility", () => {
  test("skips a system-owned source account that carries data", async () => {
    const { slrd, destination } = fixture(80);
    const plan = await planRegistrySolSweep(slrd, {
      destination: destination.toBase58(),
      maxBalanceSol: "1",
    });

    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]?.sendLamports).toBe(0n);
    expect(plan.rows[0]?.skippedReason).toBe("source-account-has-data");
  });

  test("skips a source account not owned by the System Program", async () => {
    const { slrd, destination } = fixture(0, Keypair.generate().publicKey);
    const plan = await planRegistrySolSweep(slrd, {
      destination: destination.toBase58(),
      maxBalanceSol: "1",
    });

    expect(plan.rows[0]?.sendLamports).toBe(0n);
    expect(plan.rows[0]?.skippedReason).toBe("source-not-system-owned");
  });

  test("plain system wallet remains sweepable", async () => {
    const { slrd, destination } = fixture(0);
    const plan = await planRegistrySolSweep(slrd, {
      destination: destination.toBase58(),
      maxBalanceSol: "1",
    });

    expect(plan.rows[0]?.skippedReason).toBeUndefined();
    expect(plan.rows[0]?.sendLamports).toBe(995_000n);
  });
});
