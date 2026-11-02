import { expect, test } from "bun:test";
import {
  Keypair, PublicKey, SystemProgram, TransactionInstruction,
  type Connection,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Solard } from "./solard.ts";
import { SOL_ASSET, sol } from "./amounts.ts";
import type { PreparedTokenDeployment } from "../launches/launchpad.ts";

const payer = Keypair.generate().publicKey;
const mint = Keypair.generate();
const quote = Keypair.generate().publicKey;
const custom = { kind: "spl-token" as const, mint: quote,
  tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: 6 };
function ix(tag: number) {
  return new TransactionInstruction({ programId: SystemProgram.programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: mint.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from([tag]) });
}
function deployment(quoteAsset = SOL_ASSET): PreparedTokenDeployment {
  return { launchpad: "test", mint, user: payer, creator: payer,
    quoteAsset, token: { mint: mint.publicKey.toBase58() },
    instructions: [ix(1)], signers: [mint],
    metadata: { source: "unit-fixture" },
  };
}
function host(plugin: Record<string, unknown>) {
  let signerReads = 0;
  const core = Object.create(Solard.prototype) as Solard;
  core.signer = (() => { signerReads++; throw new Error("WALLET_SECRET_ACCESSED"); }) as any;
  core.connection = () => ({
    getSignaturesForAddress: async () => [],
    getAddressLookupTable: async () => ({ value: null }),
  }) as unknown as Connection;
  Object.defineProperty(core, "blockhash", { value: { get: async () => ({
    blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 50,
  }) } });
  Object.defineProperty(core, "alts", { value: { list: () => [] } });
  Object.defineProperty(core, "launchpads", { value: { resolve: () => plugin } });
  return { core, reads: () => signerReads };
}

test("public-key-only launch plan is unsigned, atomic and identifies mint signer", async () => {
  const { core, reads } = host({
    prepareDeployment: async (_connection: Connection, args: any) => ({
      ...deployment(), user: args.user, mint: args.mint ?? mint,
    }),
  });
  const result = await core.prepareUnsignedTokenDeployment("test", {
    payer, mint, name: "No Send", symbol: "NONE", uri: "https://example.test/none",
  });
  expect(result.plan.serializedSize).toBeLessThanOrEqual(1232);
  expect(result.plan.draft.instructions).toHaveLength(1);
  expect(result.plan.draft.signers[0]?.publicKey.equals(mint.publicKey)).toBe(true);
  expect(result.plan.draft.actions[0]?.kind).toBe("deploy-token");
  expect(result.plan.draft.actions[0]?.meta?.quoteMint).toBe(SOL_ASSET.mint.toBase58());
  expect(result.plan.transaction.signatures).toHaveLength(2);
  expect(result.plan.transaction.signatures.every(row => row.every(byte => byte === 0)))
    .toBe(true);
  expect(reads()).toBe(0);
});

test("public unsigned launch never proceeds when a requested creator buy is omitted", async () => {
  const { core, reads } = host({
    prepareDeployment: async () => deployment(),
  });
  await expect(core.prepareUnsignedTokenDeployment("test", {
    payer, mint, name: "Required Buy", symbol: "REQ", uri: "https://example.test/req",
    creatorBuySol: sol("0.001"),
  })).rejects.toThrow();
  expect(reads()).toBe(0);
});

test("unsupported direct token-quote initialBuy never degrades into create-only", async () => {
  const { core, reads } = host({
    prepareDeployment: async () => deployment(custom),
  });
  await expect(core.prepareUnsignedTokenDeployment("test", {
    payer, mint, name: "Direct Quote", symbol: "DIRECT", uri: "https://example.test/direct",
    quoteAsset: custom, initialBuy: { asset: custom, raw: 1000n },
  })).rejects.toThrow("requires creatorBuySol");
  expect(reads()).toBe(0);
});

test("custom quote transaction metadata preserves chain program and decimal identity", async () => {
  const { core, reads } = host({
    prepareDeployment: async () => deployment(custom),
  });
  const { plan } = await core.prepareUnsignedTokenDeployment("test", {
    payer, mint, name: "Token Quote", symbol: "TQ", uri: "https://example.test/tq",
    quoteAsset: custom,
  });
  const meta = plan.draft.actions[0]?.meta;
  expect(meta?.quoteMint).toBe(quote.toBase58());
  expect(meta?.quoteTokenProgram).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  expect(meta?.quoteDecimals).toBe(6);
  expect(meta?.quoteTokenProgram).not.toBe(TOKEN_PROGRAM_ID.toBase58());
  expect(reads()).toBe(0);
});

test("unsigned plan assembly cannot hide a packet larger than 1232 bytes", async () => {
  const { core, reads } = host({
    prepareDeployment: async () => ({
      ...deployment(), instructions: [new TransactionInstruction({
        programId: SystemProgram.programId, keys: [], data: Buffer.alloc(1900),
      })],
    }),
  });
  await expect(core.prepareUnsignedTokenDeployment("test", {
    payer, mint, name: "Oversized", symbol: "BIG", uri: "https://example.test/big",
  })).rejects.toMatchObject({ code: "TRANSACTION_TOO_LARGE" });
  expect(reads()).toBe(0);
});
