import { expect, test } from "bun:test";
import { Keypair, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Solard } from "../core/solard.ts";
import { SOL_ASSET, sol } from "../core/amounts.ts";
import type { TokenRow } from "../db/schema.ts";
import type { QuoteResult, TradeVenuePlugin, VenueMarket } from "../venues/venue-plugin.ts";

function routingFixture(failExit = false) {
  const slrd: Solard = Object.create(Solard.prototype);
  const payer = Keypair.generate();
  const target = Keypair.generate().publicKey;
  const intermediate = Keypair.generate().publicKey;
  const quoteAsset = {
    kind: "spl-token" as const,
    mint: intermediate, decimals: 8, tokenProgram: TOKEN_2022_PROGRAM_ID,
  };
  const targetMarket: VenueMarket = {
    venue: "pumpswap", mint: target, quoteAsset,
    baseTokenProgram: TOKEN_PROGRAM_ID, creator: null, metadata: {},
  };
  const fundingMarket: VenueMarket = {
    ...targetMarket, mint: intermediate, quoteAsset: SOL_ASSET,
    baseTokenProgram: TOKEN_2022_PROGRAM_ID,
  };
  const calls: Array<{ mint: string; side: string; input: bigint; slippage: number }> = [];
  const instruction = (marker: number) => new TransactionInstruction({
    programId: target, keys: [], data: Buffer.from([marker]),
  });
  const quote = (market: VenueMarket, input: bigint): QuoteResult => ({
    venue: market.venue, quoteAsset: market.quoteAsset, inputRaw: input,
    expectedOutputRaw: 100n, minimumOutputRaw: 90n,
  });
  const plugin: TradeVenuePlugin = {
    id: "pumpswap",
    async resolveMarket() { return targetMarket; },
    async price() { throw new Error("not used"); },
    async quoteBuy(_context, market, amount, slippage) {
      calls.push({ mint: market.mint.toBase58(), side: "buy", input: amount.raw, slippage });
      return quote(market, amount.raw);
    },
    async quoteSell(_context, market, amount, slippage) {
      calls.push({ mint: market.mint.toBase58(), side: "sell", input: amount, slippage });
      if (failExit && market.mint.equals(intermediate)) throw new Error("exit unavailable");
      return quote(market, amount);
    },
    async buildBuy(_context, market) {
      return { venue: market.venue, quoteAsset: market.quoteAsset,
        instructions: [instruction(market.mint.equals(intermediate) ? 1 : 2)], minOutputRaw: 80n };
    },
    async buildSell(_context, market) {
      return { venue: market.venue, quoteAsset: market.quoteAsset,
        instructions: [instruction(market.mint.equals(target) ? 3 : 4)], minOutputRaw: 75n };
    },
  };
  slrd.signer = () => payer;
  slrd.resolveTokenForExecution = async (reference) => ({ mint: String(reference) } as TokenRow);
  slrd.route = async (token) => ({ plugin,
    market: token.mint === target.toBase58() ? targetMarket : fundingMarket });
  slrd.tokenBalance = async () => 1_000n;
  // The mock plugins do not use the connection; no network transport exists.
  slrd.connection = () => undefined as unknown as ReturnType<Solard["connection"]>;
  return { slrd, target, intermediate, calls };
}

test("minimum guards reject before compile/sign and atomic sell exposes guaranteed SOL minimum", async () => {
  const { slrd, target } = routingFixture(); let compilations = 0;
  slrd.compile = async () => { compilations++; throw new Error("must not sign"); };
  await expect(slrd.tx("wallet").buy(target, sol(0.1), { minOutputRaw: 81n }).build()).rejects.toMatchObject({ code: "BELOW_MINIMUM", phase: "before-submission", quotedMinimum: 80n });
  await expect(slrd.tx("wallet").sell(target, { minOutputLamports: 76n }).build()).rejects.toMatchObject({ code: "BELOW_MINIMUM", quotedMinimum: 75n });
  expect(compilations).toBe(0);
  const draft = await slrd.tx("wallet").sell(target, { minOutputLamports: 75n }).materializedDraft();
  expect(draft.actions[0]!.meta?.minOutputRaw).toBe("75");
});

test("SOL custom-pair buy builds both legs in one draft and spends only the built funding minimum", async () => {
  const { slrd, target, calls } = routingFixture();
  const draft = await slrd.tx("wallet").buy(target, sol(0.1), { slippageBps: 500 }).materializedDraft();
  expect(draft.instructions.map((instruction) => instruction.data[0])).toEqual([1, 2]);
  expect(calls.map((call) => call.input)).toEqual([100_000_000n, 80n]);
  expect(draft.actions).toHaveLength(1);
  expect(draft.actions[0]!.mint?.equals(target)).toBe(true);
  expect(draft.actions[0]!.kind).toBe("buy");
  expect((1 - calls[0]!.slippage / 10_000) ** 2).toBeGreaterThanOrEqual(0.95);
});

test("custom-pair sell atomically exits to SOL using only the built target minimum", async () => {
  const { slrd, target, calls } = routingFixture();
  const draft = await slrd.tx("wallet").sell(target, { bps: 5_000, slippageBps: 500 }).materializedDraft();
  expect(draft.instructions.map((instruction) => instruction.data[0])).toEqual([3, 4]);
  expect(calls.map((call) => call.input)).toEqual([500n, 75n]);
  expect(draft.actions).toHaveLength(1);
  expect(draft.actions[0]!.kind).toBe("sell");
  expect(draft.actions[0]!.mint?.equals(target)).toBe(true);
  expect(draft.actions[0]!.meta?.minSolOutputRaw).toBe("75");
});

test("missing exit route rejects before signing or submitting", async () => {
  const { slrd, target } = routingFixture(true);
  slrd.compile = async () => { throw new Error("compile must not run"); };
  slrd.sendPlan = async () => { throw new Error("send must not run"); };
  await expect(slrd.tx("wallet").sell(target).send()).rejects.toThrow("exit unavailable");
});
