import { expect, test } from "bun:test";
import {
  Keypair,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, AccountLayout } from "@solana/spl-token";
import { TransactionComposer } from "../tx/composer.ts";
import { SOL_ASSET } from "./amounts.ts";
import { Solard } from "./solard.ts";
import { sol } from "./amounts.ts";

test("custom-quote launch consumes only the guaranteed funding output in one instruction sequence", async () => {
  const payer = Keypair.generate();
  const mint = Keypair.generate();
  const quote = Keypair.generate().publicKey;
  const ix = (tag: number) =>
    new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [],
      data: Buffer.from([tag]),
    });
  const asset = {
    kind: "spl-token" as const,
    mint: quote,
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  const deployment = {
    launchpad: "launchlab",
    mint,
    user: payer.publicKey,
    creator: payer.publicKey,
    quoteAsset: asset,
    token: { mint: mint.publicKey.toBase58() },
    instructions: [ix(1)],
    signers: [mint],
  };
  let fundingBudget = 0n;
  let pendingInput = 0n;
  let fundingSlippage = 0;
  let pendingSlippage = 0;
  const host = Object.create(Solard.prototype) as Solard;
  Object.assign(host, {
    signer: () => payer,
    connection: () => ({}),
    launchpads: {
      resolve: () => ({ prepareDeployment: async () => deployment }),
    },
    tx: () => ({
      buy: (
        _mint: unknown,
        budget: { raw: bigint },
        options: { slippageBps: number },
      ) => {
        fundingBudget = budget.raw;
        fundingSlippage = options.slippageBps;
        return {
          materializedDraft: async () => ({
            instructions: [ix(2)],
            signers: [],
            actions: [{ kind: "buy", meta: { minOutputRaw: "123" } }],
          }),
        };
      },
    }),
    initialPendingMarketState: async () => ({}),
    preparePendingBuy: async (
      _id: unknown,
      _deployment: unknown,
      _wallet: unknown,
      amount: { raw: bigint },
      _state: unknown,
      options: { slippageBps: number },
    ) => {
      pendingInput = amount.raw;
      pendingSlippage = options.slippageBps;
      return {
        instructions: [ix(3)],
        minimumOutputRaw: 456n,
        expectedOutputRaw: 500n,
      };
    },
  });
  const result = await host.prepareTokenDeployment(
    "launchlab",
    payer.publicKey,
    {
      name: "fixture",
      symbol: "FIX",
      uri: "https://example.test/metadata.json",
      creatorBuySol: sol("0.001"),
      slippageBps: 500,
    },
  );
  expect(fundingBudget).toBe(1_000_000n);
  expect(pendingInput).toBe(123n);
  expect(fundingSlippage).toBe(pendingSlippage);
  expect((1 - fundingSlippage / 10_000) ** 2).toBeGreaterThanOrEqual(0.95);
  expect(result.instructions.map((item) => item.data[0])).toEqual([1, 2, 3]);
  expect(result.metadata?.minimumOutputRaw).toBe("456");
});

test("read-only claim discovery never asks for a wallet signer and returns explicit empty coverage", async () => {
  const wallet = Keypair.generate().publicKey;
  const host = Object.create(Solard.prototype) as Solard;
  Object.assign(host, {
    wallets: { resolve: () => ({ address: wallet }) },
    tokens: { list: () => [] },
    connection: () => ({}),
    claimSources: { list: () => [] },
    signer: () => {
      throw new Error("must not access signer");
    },
  });
  const result = await host.getClaimableCreatorFees(wallet);
  expect(result.wallet).toBe(wallet.toBase58());
  expect(result.groups).toEqual([]);
  expect(result.plans).toEqual([]);
});
test("full sell appends account closure atomically; partial sell cannot request closure", async () => {
  const payer = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const data = Buffer.alloc(165);
  AccountLayout.encode(
    {
      mint,
      owner: payer.publicKey,
      amount: 100n,
      delegateOption: 0,
      delegate: Keypair.generate().publicKey,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: payer.publicKey,
    },
    data,
  );
  const quote = { minimumOutputRaw: 10n, expectedOutputRaw: 11n };
  const host = {
    signer: () => payer,
    resolveTokenForExecution: async () => ({
      mint: mint.toBase58(),
      decimals: 6,
    }),
    route: async () => ({
      market: {
        mint,
        venue: "fixture",
        baseTokenProgram: TOKEN_PROGRAM_ID,
        quoteAsset: SOL_ASSET,
      },
      plugin: {
        quoteSell: async () => quote,
        buildSell: async () => ({
          instructions: [],
          minOutputRaw: 10n,
          expectedOutputRaw: 11n,
        }),
      },
    }),
    tokenBalance: async () => 100n,
    connection: () => ({
      getAccountInfo: async () => ({
        data,
        owner: TOKEN_PROGRAM_ID,
        lamports: 2039280,
      }),
    }),
  };
  const composer = () => new TransactionComposer(host as any, payer.publicKey);
  const draft = await composer()
    .sell(mint, { closeTokenAccount: true })
    .materializedDraft();
  expect(draft.instructions.at(-1)!.data[0]).toBe(9);
  expect(draft.actions.map((action) => action.kind)).toEqual([
    "sell",
    "close-token-account",
  ]);
  await expect(
    composer()
      .sell(mint, { bps: 1000, closeTokenAccount: true })
      .materializedDraft(),
  ).rejects.toThrow("entire token-account balance");
});
