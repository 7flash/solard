import { expect, test } from "bun:test";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Solard } from "../../core/solard.ts";
import { SOL_ASSET } from "../../core/amounts.ts";
import { SolardTransaction } from "../../tx/transaction-builder.ts";
import {
  installPumpLaunchSenders,
  preparePumpTokenLaunch,
  pumpLaunchEnvironment,
  validateHeliusTip,
  type LaunchSenderPolicy,
} from "./token-launch.ts";

const policy: LaunchSenderPolicy = {
  deploymentSender: "rpc",
  evolutionSender: "rpc",
  fastTraderSender: "rpc",
  rpcTraderSender: "rpc",
  fastTraderCount: 0,
  fastTip: {},
  jitoTip: {},
};
function fixture() {
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const fundingSigner = Keypair.generate();
  const quote = {
    kind: "spl-token" as const,
    mint: Keypair.generate().publicKey,
    decimals: 6,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  };
  const calls: {
    pending: any[];
    funding: any[];
    deployment: any[];
    compiled: any[];
  } = { pending: [], funding: [], deployment: [], compiled: [] };
  const marker = (value: number) =>
    new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [],
      data: Buffer.from([value]),
    });
  const deployment = {
    launchpad: "pump",
    mint,
    user: creator.publicKey,
    creator: creator.publicKey,
    quoteAsset: quote,
    token: { mint: mint.publicKey.toBase58() },
    instructions: [marker(1)],
    signers: [mint],
    metadata: {},
  };
  const host = Object.create(Solard.prototype) as any;
  host.signer = () => creator;
  host.resolveWallet = () => ({ address: creator.publicKey });
  host.connection = () => ({ getBalance: async () => 2_000_000 });
  host.launchpads = {
    resolve: () => ({
      prepareDeployment: async (_connection: unknown, args: any) => {
        calls.deployment.push(args);
        return deployment;
      },
    }),
  };
  host.initialPendingMarketState = async () => ({ quote: quote.mint });
  host.preparePendingBuy = async (
    _launchpad: string,
    _deployment: unknown,
    _wallet: unknown,
    amount: any,
    _state: unknown,
    options: any,
  ) => {
    calls.pending.push({ amount, options });
    if (!amount.asset.mint.equals(quote.mint))
      throw new Error("SOL was incorrectly treated as pool quote");
    return {
      launchpad: "pump",
      mint: mint.publicKey,
      buyer: creator.publicKey,
      quoteAsset: quote,
      instructions: [marker(3)],
      expectedOutputRaw: 1000n,
      minimumOutputRaw: 900n,
      nextState: {},
    };
  };
  host.tx = () => ({
    buy: (target: PublicKey, amount: any, options: any) => {
      calls.funding.push({ target, amount, options });
      return {
        materializedDraft: async () => ({
          instructions: [marker(2)],
          signers: [fundingSigner],
          actions: [
            {
              kind: "buy",
              mint: quote.mint,
              meta: {
                minOutputRaw: "100",
                lookupTableAddresses: [SystemProgram.programId.toBase58()],
              },
            },
          ],
          trackedAccounts: [],
        }),
      };
    },
  });
  host.transaction = () => new SolardTransaction();
  host.compile = async (_payer: unknown, draft: any) => {
    calls.compiled.push(draft);
    return {
      draft,
      payer: creator.publicKey,
      transaction: {},
      lookupTables: [],
      serializedSize: 100,
      recentBlockhash: "fixture",
      lastValidBlockHeight: 100,
    };
  };
  return { host, quote, mint, fundingSigner, calls, creator };
}
function args(value: ReturnType<typeof fixture>) {
  return {
    slrd: value.host,
    token: {
      alias: "fixture",
      name: "Fixture",
      symbol: "FIX",
      uri: "https://example.com/meta.json",
    },
    creatorWallet: "fixture",
    traders: [],
    creatorBuyLamports: 1_000_000n,
    creatorReserveLamports: 500_000n,
    slippageBps: 500,
    cuLimit: 600000,
    priorityMicroLamports: 20000,
    buyerPriorityMicroLamports: 20000,
    senderPolicy: policy,
    quoteAsset: value.quote,
  };
}

test("custom Pump quote creator buy composes create/fund/buy atomically using actual quote units and every signer", async () => {
  const value = fixture();
  const prepared = await preparePumpTokenLaunch(args(value));
  expect(value.calls.deployment).toHaveLength(1);
  expect(value.calls.deployment[0].creatorBuySol.asset).toBe(SOL_ASSET);
  expect(value.calls.deployment[0].creatorBuySol.raw).toBe(1_000_000n);
  expect(value.calls.funding).toHaveLength(1);
  expect(value.calls.funding[0].target.equals(value.quote.mint)).toBe(true);
  expect(value.calls.funding[0].amount.raw).toBe(1_000_000n);
  expect(value.calls.pending).toHaveLength(1);
  expect(
    value.calls.pending[0].amount.asset.mint.equals(value.quote.mint),
  ).toBe(true);
  expect(value.calls.pending[0].amount.raw).toBe(100n);
  expect(
    prepared.launchDraft.instructions.map((instruction) => instruction.data[0]),
  ).toEqual([1, 2, 3]);
  expect(
    prepared.launchDraft.signers.map((signer) => signer.publicKey.toBase58()),
  ).toEqual([
    value.mint.publicKey.toBase58(),
    value.fundingSigner.publicKey.toBase58(),
  ]);
  expect(prepared.expectedOutputByWallet[0]).toMatchObject({
    spendLamports: 1_000_000n,
    minimumOutputRaw: 900n,
  });
  expect(
    prepared.launchDraft.actions.find(
      (action) => action.kind === "launch-pump-token:initial-buy",
    )?.meta,
  ).toMatchObject({
    spendLamports: "1000000",
    reserveLamports: "500000",
    quoteInputRaw: "100",
    funding: "atomic-sol-to-quote",
  });
  expect(
    prepared.launchDraft.actions.some((action) =>
      Array.isArray(action.meta?.lookupTableAddresses),
    ),
  ).toBe(true);
});

test("custom quote follows remain explicitly unsupported and reserve failure precedes funding", async () => {
  const value = fixture();
  await expect(
    preparePumpTokenLaunch({
      ...args(value),
      traders: [
        {
          role: "trader",
          walletRef: "other",
          address: value.creator.publicKey.toBase58(),
          balanceLamports: 1000000n,
          reserveLamports: 0n,
          selectedBps: null,
          spendLamports: 100n,
        },
      ],
    }),
  ).rejects.toThrow("follower/buyer-group bundles are unsupported");
  expect(value.calls.funding).toHaveLength(0);
  await expect(
    preparePumpTokenLaunch({
      ...args(value),
      creatorReserveLamports: 1_000_001n,
    }),
  ).rejects.toThrow("cannot perform initial buy");
  expect(value.calls.deployment).toHaveLength(0);
});

test("legacy Helius launch lane retains explicit SWQOS tier and validates current minimum before submission", () => {
  const tip = { account: SystemProgram.programId.toBase58(), lamports: 5000n };
  expect(() =>
    validateHeliusTip({
      tip,
      endpoint:
        "https://sender.helius-rpc.com/fast?api-key=fixture&swqos_only=true",
      live: true,
      label: "fixture",
    }),
  ).not.toThrow();
  expect(() =>
    validateHeliusTip({
      tip: { ...tip, lamports: 200000n },
      endpoint: "https://sender.helius-rpc.com/fast",
      live: true,
      label: "fixture",
    }),
  ).toThrow("at least 1000000");
  expect(() =>
    validateHeliusTip({
      tip,
      endpoint: "https://sender.helius-rpc.com/fast?api-key=swqos_only%3Dtrue",
      live: true,
      label: "fixture",
    }),
  ).toThrow("at least 1000000");
  const senders: any[] = [];
  installPumpLaunchSenders(
    {
      registerSender: (sender: unknown) => {
        senders.push(sender);
      },
    } as any,
    {
      senderUrl:
        "https://sender.helius-rpc.com/fast?api-key=fixture&swqos_only=true",
      rpcUrl: "https://rpc.example/",
      jitoUrl: "https://mainnet.block-engine.jito.wtf",
    } as any,
  );
  expect(senders[0].id).toBe("helius-fast");
  expect(senders[0].tier).toBe("helius-swqos");
});

test("Helius launch defaults match the selected tier minimum and explicit tips remain unchanged", () => {
  const keys = [
    "SLRD_DEPLOYMENT_SENDER",
    "HELIUS_SENDER_URL",
    "HELIUS_TIP_ACCOUNT",
    "HELIUS_TIP_LAMPORTS",
  ];
  const previous = keys.map((key) => process.env[key]);
  try {
    process.env.SLRD_DEPLOYMENT_SENDER = "helius-fast";
    process.env.HELIUS_SENDER_URL =
      "https://sender.helius-rpc.com/fast?swqos_only=true";
    process.env.HELIUS_TIP_ACCOUNT = SystemProgram.programId.toBase58();
    delete process.env.HELIUS_TIP_LAMPORTS;
    expect(pumpLaunchEnvironment().policy.fastTip.lamports).toBe(5000n);
    process.env.HELIUS_SENDER_URL = "https://sender.helius-rpc.com/fast";
    expect(pumpLaunchEnvironment().policy.fastTip.lamports).toBe(1000000n);
    process.env.HELIUS_TIP_LAMPORTS = "200000";
    expect(pumpLaunchEnvironment().policy.fastTip.lamports).toBe(200000n);
  } finally {
    for (let index = 0; index < keys.length; index++)
      if (previous[index] === undefined) delete process.env[keys[index]!];
      else process.env[keys[index]!] = previous[index];
  }
});
