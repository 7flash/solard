import { expect, test } from "bun:test";
import {
  PublicKey,
  TransactionInstruction,
  type Connection,
  type Keypair,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  AccountLayout,
} from "@solana/spl-token";
import { SOL_ASSET, type QuoteAsset } from "../core/amounts.ts";
import { defaultPumpQuoteShell } from "../venues/pump/common.ts";
import type {
  TradeVenuePlugin,
  VenueMarket,
  QuoteResult,
} from "../venues/venue-plugin.ts";
import { TransactionComposer, type ComposerHost } from "./composer.ts";

const payer = NATIVE_MINT;
const mint = new PublicKey(new Uint8Array(32).fill(1));
const quoteMint = new PublicKey(new Uint8Array(32).fill(2));
function fixture(venue = "pumpswap", custom = false, balance = 1_000_000n) {
  const calls: Array<bigint> = [];
  const quoteAsset: QuoteAsset = custom
    ? {
        kind: "spl-token",
        mint: quoteMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        decimals: 6,
      }
    : SOL_ASSET;
  function market(baseMint: PublicKey, quote: QuoteAsset): VenueMarket {
    return {
      venue,
      mint: baseMint,
      quoteAsset: quote,
      baseTokenProgram: TOKEN_PROGRAM_ID,
      creator: null,
      metadata: {},
    };
  }
  const plugin = {
    id: venue,
    async quoteSell(
      _ctx: unknown,
      selected: VenueMarket,
      input: bigint,
    ): Promise<QuoteResult> {
      calls.push(input);
      return {
        venue,
        quoteAsset: selected.quoteAsset,
        inputRaw: input,
        minimumOutputRaw: input * 2n,
        expectedOutputRaw: input * 3n,
      };
    },
    async buildSell(_ctx: unknown, selected: VenueMarket, quote: QuoteResult) {
      const data = Buffer.alloc(8);
      data.writeBigUInt64LE(quote.inputRaw);
      return {
        venue,
        quoteAsset: selected.quoteAsset,
        minOutputRaw: quote.minimumOutputRaw,
        instructions: [
          new TransactionInstruction({
            programId: PublicKey.default,
            keys: [],
            data,
          }),
        ],
      };
    },
  } as unknown as TradeVenuePlugin;
  const account = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner: payer,
      amount: balance,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    account,
  );
  const host = {
    signer() {
      return { publicKey: payer } as Keypair;
    },
    async resolveTokenForExecution(ref: unknown) {
      return defaultPumpQuoteShell(ref instanceof PublicKey ? ref : mint);
    },
    async route(token: { mint: string }) {
      return {
        plugin,
        market:
          token.mint === mint.toBase58()
            ? market(mint, quoteAsset)
            : market(quoteMint, SOL_ASSET),
      };
    },
    async tokenBalance() {
      return balance;
    },
    connection() {
      return {
        async getAccountInfo() {
          return {
            data: account,
            owner: TOKEN_PROGRAM_ID,
            lamports: 1,
            executable: false,
            rentEpoch: 0,
          };
        },
      } as unknown as Connection;
    },
  } as unknown as ComposerHost;
  return { tx: () => new TransactionComposer(host, "fake"), calls };
}

test("exact raw sell isolates a 284725-unit position from a shared wallet balance", async () => {
  for (const venue of ["pump-curve", "pumpswap", "jupiter"]) {
    const f = fixture(venue);
    const draft = await f
      .tx()
      .sell(mint, { amountRaw: 284725n })
      .materializedDraft();
    expect(f.calls).toEqual([284725n]);
    expect(draft.actions[0]?.meta).toMatchObject({
      venue,
      inputRaw: "284725",
      minOutputRaw: "569450",
    });
    expect(draft.instructions[0]?.data.readBigUInt64LE()).toBe(284725n);
  }
});

test("custom-quote sell preserves the exact first leg and guaranteed SOL metadata", async () => {
  const f = fixture("pumpswap", true);
  const draft = await f
    .tx()
    .sell(mint, { amountRaw: "284725" })
    .materializedDraft();
  expect(f.calls).toEqual([284725n, 569450n]);
  expect(draft.instructions.map((ix) => ix.data.readBigUInt64LE())).toEqual([
    284725n,
    569450n,
  ]);
  expect(draft.actions[0]?.meta).toMatchObject({
    inputRaw: "284725",
    minOutputRaw: "1138900",
  });
});

test("invalid or oversized exact amounts reject before quote construction", async () => {
  for (const options of [
    { amountRaw: 0n },
    { amountRaw: "-1" },
    { amountRaw: "1.5" },
    { amountRaw: 1_000_001n },
    { amountRaw: 284725n, bps: 1000 },
    { bps: -1 },
    { bps: 1.5 },
  ]) {
    const f = fixture();
    await expect(
      f.tx().sell(mint, options).materializedDraft(),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  }
});

test("closing requires the actual entire account balance, including exact raw sells", async () => {
  const partial = fixture();
  await expect(
    partial
      .tx()
      .sell(mint, { amountRaw: 284725n, closeTokenAccount: true })
      .materializedDraft(),
  ).rejects.toThrow("entire");
  expect(partial.calls).toHaveLength(0);
  const full = fixture();
  const draft = await full
    .tx()
    .sell(mint, { amountRaw: "1000000", closeTokenAccount: true })
    .materializedDraft();
  expect(draft.actions.map((action) => action.kind)).toEqual([
    "sell",
    "close-token-account",
  ]);
  expect(full.calls).toEqual([1_000_000n]);
});
