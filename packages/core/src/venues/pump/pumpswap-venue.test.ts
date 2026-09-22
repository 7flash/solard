import { describe, expect, test } from "bun:test";
import { Buffer } from "buffer";
import {
  Keypair,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

import { normalizeZeroSlippageSdkBuyToExactQuoteIn } from "./pumpswap-venue.ts";
import {
  AMM_BUY_D8,
  AMM_BUY_EXACT_QUOTE_IN_D8,
  PUMP_AMM_PROGRAM_ID,
} from "./constants.ts";

function buyData(
  discriminator: Buffer,
  first: bigint,
  second: bigint,
  trackVolume = 1,
): Buffer {
  const data = Buffer.alloc(25);
  discriminator.copy(data, 0);
  data.writeBigUInt64LE(first, 8);
  data.writeBigUInt64LE(second, 16);
  data[24] = trackVolume;
  return data;
}

function fixture(
  args: {
    requested?: bigint;
    expectedBase?: bigint;
    funded?: bigint;
    legacyMaxQuote?: bigint;
  } = {},
) {
  const user = Keypair.generate().publicKey;
  const quoteAta = Keypair.generate().publicKey;
  const account = Keypair.generate().publicKey;
  const requested = args.requested ?? 80_000_000n;
  const expectedBase = args.expectedBase ?? 32_000_000_000n;
  const funded = args.funded ?? requested;
  const legacyMaxQuote = args.legacyMaxQuote ?? requested;
  const funding = SystemProgram.transfer({
    fromPubkey: user,
    toPubkey: quoteAta,
    lamports: funded,
  });
  const legacy = new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys: [{ pubkey: account, isSigner: false, isWritable: true }],
    data: buyData(AMM_BUY_D8, expectedBase, legacyMaxQuote),
  });
  return {
    user,
    quoteAta,
    account,
    requested,
    expectedBase,
    funding,
    legacy,
  };
}

describe("PumpSwap exact-quote-input normalization", () => {
  test("legacy zero-slippage SDK quote becomes exact input with downward BPS protection", () => {
    const f = fixture({ expectedBase: 32_188_751_532n });
    const result = normalizeZeroSlippageSdkBuyToExactQuoteIn({
      instructions: [f.funding, f.legacy],
      requestedQuoteInRaw: f.requested,
      slippageBps: 175,
      user: f.user,
      userQuoteTokenAccount: f.quoteAta,
      nativeQuote: true,
    });

    expect(result.sdkWire).toBe("buy");
    expect(result.expectedOutputRaw).toBe(32_188_751_532n);
    expect(result.minimumOutputRaw).toBe((32_188_751_532n * 9_825n) / 10_000n);

    const trade = result.instructions[1]!;
    expect(Buffer.from(trade.data.subarray(0, 8))).toEqual(
      AMM_BUY_EXACT_QUOTE_IN_D8,
    );
    expect(Buffer.from(trade.data).readBigUInt64LE(8)).toBe(f.requested);
    expect(Buffer.from(trade.data).readBigUInt64LE(16)).toBe(
      result.minimumOutputRaw,
    );
    expect(trade.keys).toEqual(f.legacy.keys);
  });

  test("does not reuse legacy baseOut directly as exact-input minimum", () => {
    const f = fixture({ expectedBase: 32_188_751_532n });
    const result = normalizeZeroSlippageSdkBuyToExactQuoteIn({
      instructions: [f.funding, f.legacy],
      requestedQuoteInRaw: f.requested,
      slippageBps: 175,
      user: f.user,
      userQuoteTokenAccount: f.quoteAta,
      nativeQuote: true,
    });

    expect(result.minimumOutputRaw).toBeLessThan(result.expectedOutputRaw);
    expect(result.minimumOutputRaw).not.toBe(f.expectedBase);
  });

  test("accepts SDK exact-input wire at zero slippage then applies Solard BPS", () => {
    const f = fixture({ expectedBase: 25_000_000_000n });
    const exact = new TransactionInstruction({
      programId: PUMP_AMM_PROGRAM_ID,
      keys: f.legacy.keys,
      data: buyData(AMM_BUY_EXACT_QUOTE_IN_D8, f.requested, f.expectedBase),
    });

    const result = normalizeZeroSlippageSdkBuyToExactQuoteIn({
      instructions: [f.funding, exact],
      requestedQuoteInRaw: f.requested,
      slippageBps: 200,
      user: f.user,
      userQuoteTokenAccount: f.quoteAta,
      nativeQuote: true,
    });

    expect(result.sdkWire).toBe("buy_exact_quote_in");
    expect(result.expectedOutputRaw).toBe(f.expectedBase);
    expect(result.minimumOutputRaw).toBe((f.expectedBase * 9_800n) / 10_000n);
  });

  test("fails closed if zero-slippage legacy SDK still increases maxQuote", () => {
    const f = fixture({ legacyMaxQuote: 81_400_000n });
    expect(() =>
      normalizeZeroSlippageSdkBuyToExactQuoteIn({
        instructions: [f.funding, f.legacy],
        requestedQuoteInRaw: f.requested,
        slippageBps: 175,
        user: f.user,
        userQuoteTokenAccount: f.quoteAta,
        nativeQuote: true,
      }),
    ).toThrow("zero-slippage SDK legacy buy did not preserve quote budget");
  });

  test("fails closed if native quote funding is not exactly the strategy budget", () => {
    const f = fixture({ funded: 81_400_000n });
    expect(() =>
      normalizeZeroSlippageSdkBuyToExactQuoteIn({
        instructions: [f.funding, f.legacy],
        requestedQuoteInRaw: f.requested,
        slippageBps: 175,
        user: f.user,
        userQuoteTokenAccount: f.quoteAta,
        nativeQuote: true,
      }),
    ).toThrow("WSOL funding does not equal exact quote budget");
  });
});
