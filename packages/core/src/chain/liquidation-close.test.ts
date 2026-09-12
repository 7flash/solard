import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import type { Solard } from "../core/solard.ts";
import {
  executeRegistryTokenLiquidation,
  type RegistryTokenLiquidationPlan,
} from "./liquidation.ts";

type FixtureMode =
  | "close-immediately"
  | "broadcast-then-close"
  | "fail-once-then-close"
  | "account-not-found-once"
  | "always-fail";

function fixture(mode: FixtureMode) {
  const wallet = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const tokenAccount = Keypair.generate().publicKey.toBase58();
  let exists = true;
  let broadcasts = 0;
  let rebroadcasts = 0;
  let confirms = 0;
  let lastSignature = "";
  let priorityMicroLamports = 0;
  const account = {
    address: tokenAccount,
    mint,
    owner: wallet,
    amountRaw: 0n,
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    lamports: 2_039_280n,
    isAssociated: false,
    state: "initialized",
    closeAuthority: null,
  };

  const composer: any = {
    add: () => composer,
    priorityFee: (value: { microLamports?: number }) => {
      priorityMicroLamports = value.microLamports ?? 0;
      return composer;
    },
    closeTokenAccountAddress: () => composer,
    build: async () => ({
      transaction: {},
      draft: {
        instructions: [],
        signers: [],
        actions: [],
        trackedAccounts: [],
      },
      lookupTables: [],
      serializedSize: 1,
      payer: Keypair.generate().publicKey,
      recentBlockhash: `blockhash-${broadcasts + 1}`,
      lastValidBlockHeight: 200,
    }),
  };

  const slrd = {
    tokens: { list: () => [] },
    tokenAccounts: async () => (exists ? [account] : []),
    tx: () => composer,
    submitPlan: async (plan: any, sender: string) => {
      broadcasts += 1;
      if (mode === "account-not-found-once" && broadcasts === 1) {
        throw new Error('Simulation failed: "AccountNotFound"');
      }
      lastSignature = Keypair.generate().publicKey.toBase58();
      if (
        mode === "close-immediately" ||
        mode === "account-not-found-once" ||
        (mode === "fail-once-then-close" && broadcasts >= 2)
      ) {
        exists = false;
      }
      return {
        signature: lastSignature,
        sender,
        executionId: broadcasts,
        plan,
      };
    },
    confirmSignature: async (signature: string, sender: string) => {
      confirms += 1;
      if (mode === "always-fail" || mode === "fail-once-then-close") {
        return {
          signature,
          slot: 123,
          sender,
          status: "failed" as const,
          error: "test failure",
        };
      }
      return {
        signature,
        slot: null,
        sender,
        status: "submitted" as const,
      };
    },
    senders: {
      resolve: () => ({
        send: async () => {
          rebroadcasts += 1;
          if (mode === "broadcast-then-close") exists = false;
          return lastSignature;
        },
      }),
    },
    connection: () => ({
      getAccountInfo: async () =>
        exists ? { lamports: Number(account.lamports) } : null,
      getBlockHeight: async () => 100,
      getRecentPrioritizationFees: async () => [{ prioritizationFee: 5_000 }],
    }),
  } as unknown as Solard;

  const plan: RegistryTokenLiquidationPlan = {
    protectedMints: [],
    actions: [
      {
        kind: "close-empty",
        walletName: "test",
        walletAddress: wallet,
        mint,
        name: null,
        symbol: null,
        decimals: 6,
        amountRaw: 0n,
        amountUi: "0",
        tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        rentLamports: account.lamports,
      },
    ],
    totals: {
      wallets: 1,
      sell: 0,
      jupiterSell: 0,
      unwrapWsol: 0,
      closeEmpty: 1,
      keepProtected: 0,
      skipUnsupported: 0,
    },
  };

  return {
    slrd,
    plan,
    tokenAccount,
    stats: () => ({
      exists,
      broadcasts,
      rebroadcasts,
      confirms,
      priorityMicroLamports,
    }),
  };
}

describe("registry liquidation empty-account closure", () => {
  test("reports success only after the exact account is absent", async () => {
    const { slrd, plan, stats } = fixture("close-immediately");
    const result = await executeRegistryTokenLiquidation(slrd, plan, {
      delayMs: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.error).toBeUndefined();
    expect(result[0]?.receipt?.status).toBe("submitted");
    expect(stats().exists).toBe(false);
    expect(stats().priorityMicroLamports).toBe(10_000);
  });

  test("rebroadcasts the same unresolved close instead of declaring submission a failure", async () => {
    const { slrd, plan, stats } = fixture("broadcast-then-close");
    const result = await executeRegistryTokenLiquidation(slrd, plan, {
      delayMs: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.error).toBeUndefined();
    expect(stats().exists).toBe(false);
    expect(stats().broadcasts).toBe(1);
    expect(stats().rebroadcasts).toBe(1);
    expect(stats().confirms).toBe(1);
  });

  test("retries a confirmed failed close from fresh state and converges", async () => {
    const { slrd, plan, stats } = fixture("fail-once-then-close");
    const result = await executeRegistryTokenLiquidation(slrd, plan, {
      delayMs: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.error).toBeUndefined();
    expect(stats().exists).toBe(false);
    expect(stats().broadcasts).toBe(2);
  });

  test("treats AccountNotFound as a retryable race until confirmed state proves absence", async () => {
    const { slrd, plan, stats } = fixture("account-not-found-once");
    const result = await executeRegistryTokenLiquidation(slrd, plan, {
      delayMs: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.error).toBeUndefined();
    expect(stats().exists).toBe(false);
    expect(stats().broadcasts).toBe(2);
  });

  test("fails only after fresh-state convergence attempts are exhausted", async () => {
    const { slrd, plan, tokenAccount, stats } = fixture("always-fail");
    const result = await executeRegistryTokenLiquidation(slrd, plan, {
      delayMs: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.error).toContain(tokenAccount);
    expect(stats().exists).toBe(true);
    expect(stats().broadcasts).toBe(3);
    expect(stats().confirms).toBe(3);
  });
});

test("rereads an unsellable token account after AccountNotFound, verifies zero, then closes it", async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const tokenAccount = Keypair.generate().publicKey.toBase58();
  let exists = true;
  let amountRaw = 10n;
  let burnSends = 0;
  const account = () => ({
    address: tokenAccount,
    mint,
    owner: wallet,
    amountRaw,
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    lamports: 2_039_280n,
    isAssociated: false,
    state: "initialized",
    closeAuthority: null,
  });

  const slrd = {
    tokens: { list: () => [] },
    signer: () => ({ publicKey: Keypair.generate().publicKey }),
    tokenAccounts: async () => (exists ? [account()] : []),
    tx: () => {
      let burn = false;
      const composer: any = {
        priorityFee: () => composer,
        add: (_instruction: unknown, action: { kind?: string }) => {
          burn = action?.kind === "burn-token";
          return composer;
        },
        closeTokenAccountAddress: () => composer,
        send: async () => {
          if (!burn) throw new Error("unexpected direct close send");
          burnSends += 1;
          if (burnSends === 1) {
            throw new Error('Simulation failed: "AccountNotFound"');
          }
          amountRaw = 0n;
          return {
            signature: Keypair.generate().publicKey.toBase58(),
            slot: 123,
            sender: "rpc",
            status: "confirmed" as const,
          };
        },
        build: async () => ({
          transaction: {},
          draft: {
            instructions: [],
            signers: [],
            actions: [],
            trackedAccounts: [],
          },
          lookupTables: [],
          serializedSize: 1,
          payer: Keypair.generate().publicKey,
          recentBlockhash: "blockhash",
          lastValidBlockHeight: 200,
        }),
      };
      return composer;
    },
    submitPlan: async (built: any, sender: string) => {
      exists = false;
      return {
        signature: Keypair.generate().publicKey.toBase58(),
        sender,
        executionId: 1,
        plan: built,
      };
    },
    confirmSignature: async (signature: string, sender: string) => ({
      signature,
      slot: 123,
      sender,
      status: "confirmed" as const,
    }),
    senders: {
      resolve: () => ({
        send: async () => Keypair.generate().publicKey.toBase58(),
      }),
    },
    connection: () => ({
      getAccountInfo: async () => (exists ? { lamports: 2_039_280 } : null),
      getBlockHeight: async () => 100,
      getRecentPrioritizationFees: async () => [],
    }),
  } as unknown as Solard;

  const plan: RegistryTokenLiquidationPlan = {
    protectedMints: [],
    actions: [
      {
        kind: "skip-unsupported",
        walletName: "test",
        walletAddress: wallet,
        mint,
        name: null,
        symbol: null,
        decimals: 6,
        amountRaw,
        amountUi: "0.00001",
        reason: "no route",
      },
    ],
    totals: {
      wallets: 1,
      sell: 0,
      jupiterSell: 0,
      unwrapWsol: 0,
      closeEmpty: 0,
      keepProtected: 0,
      skipUnsupported: 1,
    },
  };

  const result = await executeRegistryTokenLiquidation(slrd, plan, {
    delayMs: 0,
    burnUnsellable: true,
  });
  expect(result.some((row) => row.error)).toBe(false);
  expect(result.some((row) => row.action.kind === "close-empty")).toBe(true);
  expect(burnSends).toBe(2);
  expect(amountRaw).toBe(0n);
  expect(exists).toBe(false);
});
