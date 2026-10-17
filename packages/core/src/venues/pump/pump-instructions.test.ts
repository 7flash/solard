import { expect, test } from "bun:test";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { SOL_ASSET, type QuoteAsset } from "../../core/amounts.ts";
import { buildCurveBuyV2, buildCurveSellV2 } from "./pump-instructions.ts";
import { ata } from "./pda.ts";

const key = (value: number) => new PublicKey(new Uint8Array(32).fill(value));
const quote: QuoteAsset = {
  kind: "spl-token", mint: key(2), decimals: 6, tokenProgram: TOKEN_2022_PROGRAM_ID,
};
const user = key(3);
const buyback = key(4);
const routing = {
  feeRecipient: key(5), associatedQuoteFeeRecipient: key(6),
  buybackFeeRecipient: buyback,
  associatedQuoteBuybackFeeRecipient: ata(quote.mint, buyback, quote.tokenProgram, true),
  creatorVault: key(7), associatedCreatorVault: key(8),
};
const args = { mint: key(1), user, baseTokenProgram: TOKEN_2022_PROGRAM_ID, quote, routing };

test("custom-quote curve buy and sell create the actual quote buyback ATA before trading", () => {
  const buy = buildCurveBuyV2({ ...args, quoteInRaw: 100n, minBaseOutRaw: 20n });
  const sell = buildCurveSellV2({ ...args, baseInRaw: 20n, minQuoteOutRaw: 90n });
  for (const instructions of [buy, sell]) {
    const setup = instructions.at(-2)!;
    const trade = instructions.at(-1)!;
    expect(setup.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect([...setup.data]).toEqual([1]);
    expect(setup.keys[0]!.pubkey.equals(user)).toBe(true);
    expect(setup.keys[1]!.pubkey.equals(routing.associatedQuoteBuybackFeeRecipient)).toBe(true);
    expect(setup.keys[2]!.pubkey.equals(buyback)).toBe(true);
    expect(setup.keys[3]!.pubkey.equals(quote.mint)).toBe(true);
    expect(setup.keys[5]!.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(trade.keys[4]!.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(trade.keys[9]!.pubkey.equals(setup.keys[1]!.pubkey)).toBe(true);
  }
  expect(buy.at(-1)!.data.readBigUInt64LE(8)).toBe(100n);
  expect(buy.at(-1)!.data.readBigUInt64LE(16)).toBe(20n);
  expect(sell.at(-1)!.data.readBigUInt64LE(8)).toBe(20n);
  expect(sell.at(-1)!.data.readBigUInt64LE(16)).toBe(90n);
});

test("native SOL curve trades retain native buyback routing", () => {
  expect(buildCurveBuyV2({ ...args, quote: SOL_ASSET, quoteInRaw: 100n, minBaseOutRaw: 20n })).toHaveLength(2);
  expect(buildCurveSellV2({ ...args, quote: SOL_ASSET, baseInRaw: 20n, minQuoteOutRaw: 90n })).toHaveLength(1);
});
