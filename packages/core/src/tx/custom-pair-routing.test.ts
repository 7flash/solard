import { expect, test } from "bun:test";
import { Keypair, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Solard } from "../core/solard.ts";
import { SOL_ASSET, sol } from "../core/amounts.ts";
import { PUMP_PROGRAM_ID } from "../venues/pump/constants.ts";
import type { TokenRow } from "../db/schema.ts";
import type {
  QuoteResult,
  TradeVenuePlugin,
  VenueMarket,
} from "../venues/venue-plugin.ts";

function routingFixture(failExit = false, fundingVenue = "pumpswap") {
  const slrd: Solard = Object.create(Solard.prototype);
  const payer = Keypair.generate();
  const target = Keypair.generate().publicKey;
  const intermediate = Keypair.generate().publicKey;
  const quoteAsset = {
    kind: "spl-token" as const,
    mint: intermediate,
    decimals: 8,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  };
  const targetMarket: VenueMarket = {
    venue: "pumpswap",
    mint: target,
    quoteAsset,
    baseTokenProgram: TOKEN_PROGRAM_ID,
    creator: null,
    metadata: {},
  };
  const fundingMarket: VenueMarket = {
    ...targetMarket,
    venue: fundingVenue,
    mint: intermediate,
    quoteAsset: SOL_ASSET,
    baseTokenProgram: TOKEN_2022_PROGRAM_ID,
  };
  const calls: Array<{
    mint: string;
    side: string;
    input: bigint;
    slippage: number;
  }> = [];
  const instruction = (marker: number) =>
    new TransactionInstruction({
      programId: target,
      keys: [],
      data: Buffer.from([marker]),
    });
  const quote = (market: VenueMarket, input: bigint): QuoteResult => ({
    venue: market.venue,
    quoteAsset: market.quoteAsset,
    inputRaw: input,
    expectedOutputRaw: 100n,
    minimumOutputRaw: 90n,
  });
  const plugin: TradeVenuePlugin = {
    id: "pumpswap",
    async resolveMarket() {
      return targetMarket;
    },
    async price() {
      throw new Error("not used");
    },
    async quoteBuy(_context, market, amount, slippage) {
      calls.push({
        mint: market.mint.toBase58(),
        side: "buy",
        input: amount.raw,
        slippage,
      });
      return quote(market, amount.raw);
    },
    async quoteSell(_context, market, amount, slippage) {
      calls.push({
        mint: market.mint.toBase58(),
        side: "sell",
        input: amount,
        slippage,
      });
      if (failExit && market.mint.equals(intermediate))
        throw new Error("exit unavailable");
      return quote(market, amount);
    },
    async buildBuy(_context, market, quote) {
      return {
        venue: market.venue,
        quoteAsset: market.quoteAsset,
        instructions: [instruction(market.mint.equals(intermediate) ? 1 : 2)],
        minOutputRaw: quote.meta?.absoluteMinimumOutputRaw == null ? 80n : quote.minimumOutputRaw,
        meta: { lookupTableAddresses: [market.mint.toBase58()] },
      };
    },
    async buildSell(_context, market, quote) {
      return {
        venue: market.venue,
        quoteAsset: market.quoteAsset,
        instructions: [instruction(market.mint.equals(target) ? 3 : 4)],
        minOutputRaw: quote.meta?.absoluteMinimumOutputRaw == null ? 75n : quote.minimumOutputRaw,
        meta: { lookupTableAddresses: [market.mint.toBase58()] },
      };
    },
  };
  slrd.signer = () => payer;
  slrd.resolveTokenForExecution = async (reference) =>
    ({ mint: String(reference), decimals: 6 }) as TokenRow;
  slrd.route = async (token) => ({
    plugin,
    market: token.mint === target.toBase58() ? targetMarket : fundingMarket,
  });
  slrd.tokenBalance = async () => 1_000n;
  slrd.connection = () =>
    ({ async getAccountInfo() {
      const data = Buffer.alloc(1045);
      intermediate.toBuffer().copy(data, 1013);
      return { data, owner: PUMP_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 };
    } }) as unknown as ReturnType<Solard["connection"]>;
  return { slrd, target, intermediate, calls, plugin };
}

test("prepared custom buy encodes an out-of-market token floor without consuming unrelated quote holdings", async () => {
  const {slrd,target,calls}=routingFixture();
  await expect(slrd.tx("wallet").buy(target,sol("0.1"),{maxPriceSol:"500"}).materializedDraft())
    .rejects.toMatchObject({code:"BELOW_MINIMUM"});
  calls.length=0;
  const draft=await slrd.tx("wallet").prepareLimitOrder()
    .buy(target,sol("0.1"),{maxPriceSol:"500"}).materializedDraft();
  expect(draft.instructions.map(ix=>ix.data[0])).toEqual([1,2]);
  expect(calls.map(call=>call.input)).toEqual([100000000n,80n]);
  expect(draft.actions[0]!.meta?.minOutputRaw).toBe("200");
});

test("spot-trigger custom orders translate boundary through verified quote/SOL and compound no more than 2% extra",async()=>{
  for(const fundingVenue of ['pumpswap','jupiter'])for(const side of ["buy","sell"] as const){
    const {slrd,target,intermediate,plugin}=routingFixture(false,fundingVenue);
    const amounts:bigint[]=[],boundaries:Array<string|undefined>=[];
    plugin.price=async(_ctx,market)=>({venue:market.venue,mint:market.mint,quoteAsset:market.quoteAsset,
      priceQuotePerToken:2,capturedAtMs:Date.now()});
    const quote=(ctx:any,market:VenueMarket,input:bigint,bps:number)=>{
      amounts.push(input);boundaries.push(ctx.boundaryPriceQuotePerToken);
      const expected=market.mint.equals(intermediate)&&side==="buy"?1000n:input;
      return {venue:market.venue,quoteAsset:market.quoteAsset,inputRaw:input,expectedOutputRaw:expected,
        minimumOutputRaw:expected*BigInt(10000-bps)/10000n};
    };
    plugin.quoteBuy=async(ctx,market,amount,bps)=>quote(ctx,market,amount.raw,bps);
    plugin.quoteSell=async(ctx,market,input,bps)=>quote(ctx,market,input,bps);
    const composer=slrd.tx("wallet").prepareLimitOrder({priceSol:"100",additionalSlippageBps:200});
    const draft=await (side==="buy"?composer.buy(target,sol("0.1")):composer.sell(target,{amountRaw:"1000"})).materializedDraft();
    expect(boundaries).toEqual(side==="buy"?[undefined,"50"]:["50",undefined]);
    expect(amounts[1]).toBe(990n);
    expect(draft.actions[0]!.meta?.minOutputRaw).toBe("980");
    expect(draft.actions[0]!.meta?.additionalSlippageBps).toBe(200);
    expect(draft.instructions.map(ix=>ix.data[0])).toEqual(side==="buy"?[1,2]:[3,4]);
  }
});

test("prepared custom sell preserves target leg floor and out-of-market aggregate SOL floor", async () => {
  const {slrd,target,calls}=routingFixture();
  const draft=await slrd.tx("wallet").prepareLimitOrder()
    .sell(target,{amountRaw:"500",minPriceSol:"0.001"}).materializedDraft();
  expect(calls.map(call=>call.input)).toEqual([500n,75n]);
  expect(draft.actions[0]!.meta?.minSolOutputRaw).toBe("500");
  expect(draft.actions[0]!.meta?.guaranteedIntermediateRaw).toBe("75");
  expect(draft.instructions.map(ix=>ix.data[0])).toEqual([3,4]);
});

test("price-only custom buy spends full guaranteed funding without default haircut and encodes both minima", async () => {
  const {slrd,target,intermediate,plugin}=routingFixture();
  const inputs: bigint[]=[];
  plugin.quoteBuy=async(_ctx,market,amount,slippage)=>{
    inputs.push(amount.raw);
    const expected=market.mint.equals(intermediate)?100n:amount.raw;
    return {venue:market.venue,quoteAsset:market.quoteAsset,inputRaw:amount.raw,
      expectedOutputRaw:expected,minimumOutputRaw:expected*BigInt(10000-slippage)/10000n};
  };
  plugin.buildBuy=async(_ctx,market,quote)=>{
    const data=Buffer.alloc(8);data.writeBigUInt64LE(quote.minimumOutputRaw);
    return {venue:market.venue,quoteAsset:market.quoteAsset,
      minOutputRaw:quote.minimumOutputRaw,expectedOutputRaw:quote.expectedOutputRaw,
      instructions:[new TransactionInstruction({programId:target,keys:[],data})]};
  };
  const draft=await slrd.tx('wallet').buy(target,sol('0.1'),{maxPriceSol:'1050'}).materializedDraft();
  expect(inputs).toEqual([100000000n,100n]);
  expect(draft.instructions.map(ix=>ix.data.readBigUInt64LE())).toEqual([100n,96n]);
  expect(draft.actions[0]?.meta?.inputRaw).toBe('100000000');
  expect(draft.actions[0]?.meta?.minOutputRaw).toBe('96');
  // A genuine price violation still fails. No compile/sign/send is reached.
  await expect(slrd.tx('wallet').buy(target,sol('0.1'),{maxPriceSol:'900'}).materializedDraft()).rejects.toThrow('below required');
});

test("absolute custom-pair floors apply to final token/SOL outputs and preserve intermediate limits", async () => {
  const buy = routingFixture();
  const bought = await buy.slrd.tx("wallet").buy(buy.target, sol("0.1"), { outputMinimumRaw: 85n }).materializedDraft();
  expect(bought.actions[0]?.meta?.minOutputRaw).toBe("85");
  expect(buy.calls.map(call => call.input)).toEqual([100_000_000n, 80n]);
  const sell = routingFixture();
  const sold = await sell.slrd.tx("wallet").sell(sell.target, { outputMinimumRaw: 88n }).materializedDraft();
  expect(sold.actions[0]?.meta?.minSolOutputRaw).toBe("88");
  expect(sell.calls.map(call => call.input)).toEqual([1000n, 75n]);
  await expect(sell.slrd.tx("wallet").sell(sell.target, { outputMinimumRaw: 101n }).materializedDraft())
    .rejects.toThrow("below required");
});
test("price-only SDK buy derives its output floor instead of imposing default percentage slippage", async () => {
  const { slrd, target, calls } = routingFixture();
  const draft = await slrd.tx("wallet").buy(target, sol("0.1"), { maxPriceSol: "1100" }).materializedDraft();
  expect(draft.actions[0]?.meta?.minOutputRaw).toBe("91");
  expect(calls[0]!.slippage).toBe(0);
  expect(calls[1]!.slippage).toBe(0);
  expect(calls[1]!.input).toBe(80n);
  expect(draft.actions[0]?.meta?.fundingRoute).toMatchObject({ guaranteedIntermediateRaw: "80" });
  await expect(slrd.tx("wallet").buy(target, sol("0.1"), {
    maxPriceSol: "1100", slippageBps: 500,
  }).materializedDraft()).rejects.toThrow("worst-case quote");
});
test("price-only sell enforces the stricter price/profit floor without default slippage haircut", async () => {
  const { slrd, target, calls } = routingFixture();
  const draft = await slrd.tx("wallet").sell(target, {
    minPriceSol: "0.00009", minOutputLamports: 95n,
  }).materializedDraft();
  expect(draft.actions[0]?.meta?.minSolOutputRaw).toBe("95");
  expect(calls.map(call => call.slippage)).toEqual([0, 0]);
  const priceWins = await slrd.tx("wallet").sell(target, {
    minPriceSol: "0.000096", minOutputLamports: 88n,
  }).materializedDraft();
  expect(priceWins.actions[0]?.meta?.minSolOutputRaw).toBe("96");
  await expect(slrd.tx("wallet").sell(target, {
    minPriceSol: "0.00009", minOutputLamports: 95n, slippageBps: 1500,
  }).materializedDraft()).rejects.toThrow("below required");
  await expect(slrd.tx("wallet").sell(target, {
    minPriceSol: "0.000101", minOutputLamports: 95n,
  }).materializedDraft()).rejects.toThrow("below required");
});

test("minimum guards reject before compile/sign and atomic sell exposes guaranteed SOL minimum", async () => {
  const { slrd, target } = routingFixture();
  let compilations = 0;
  slrd.compile = async () => {
    compilations++;
    throw new Error("must not sign");
  };
  await expect(
    slrd.tx("wallet").buy(target, sol(0.1), { minOutputRaw: 81n }).build(),
  ).rejects.toMatchObject({
    code: "BELOW_MINIMUM",
    phase: "before-submission",
    quotedMinimum: 80n,
  });
  await expect(
    slrd.tx("wallet").sell(target, { minOutputLamports: 76n }).build(),
  ).rejects.toMatchObject({ code: "BELOW_MINIMUM", quotedMinimum: 75n });
  expect(compilations).toBe(0);
  const draft = await slrd
    .tx("wallet")
    .sell(target, { minOutputLamports: 75n })
    .materializedDraft();
  expect(draft.actions[0]!.meta?.minOutputRaw).toBe("75");
});

test("SOL custom-pair buy builds both legs in one draft and spends only the built funding minimum", async () => {
  const { slrd, target, calls } = routingFixture();
  const draft = await slrd
    .tx("wallet")
    .buy(target, sol(0.1), { slippageBps: 500 })
    .materializedDraft();
  expect(draft.instructions.map((instruction) => instruction.data[0])).toEqual([
    1, 2,
  ]);
  expect(calls.map((call) => call.input)).toEqual([100_000_000n, 80n]);
  expect(draft.actions[0]!.meta?.lookupTableAddresses).toEqual([target.toBase58(), calls[0]!.mint]);
  expect(draft.actions).toHaveLength(1);
  expect(draft.actions[0]!.mint?.equals(target)).toBe(true);
  expect(draft.actions[0]!.kind).toBe("buy");
  expect((1 - calls[0]!.slippage / 10_000) ** 2).toBeGreaterThanOrEqual(0.95);
});

test("custom-pair sell atomically exits to SOL using only the built target minimum", async () => {
  const { slrd, target, calls } = routingFixture();
  const draft = await slrd
    .tx("wallet")
    .sell(target, { bps: 5_000, slippageBps: 500 })
    .materializedDraft();
  expect(draft.instructions.map((instruction) => instruction.data[0])).toEqual([
    3, 4,
  ]);
  expect(calls.map((call) => call.input)).toEqual([500n, 75n]);
  expect(draft.actions).toHaveLength(1);
  expect(draft.actions[0]!.kind).toBe("sell");
  expect(draft.actions[0]!.mint?.equals(target)).toBe(true);
  expect(draft.actions[0]!.meta?.minSolOutputRaw).toBe("75");
});

test("missing exit route rejects before signing or submitting", async () => {
  const { slrd, target } = routingFixture(true);
  slrd.compile = async () => {
    throw new Error("compile must not run");
  };
  slrd.sendPlan = async () => {
    throw new Error("send must not run");
  };
  await expect(slrd.tx("wallet").sell(target).send()).rejects.toThrow(
    "exit unavailable",
  );
});

test("existing custom AMM pool may fund an external quote without granting Pump launch admission", async () => {
 const {slrd,target,calls}=routingFixture(false,"jupiter");
 slrd.connection=()=>({getAccountInfo:async()=>{throw new Error("Pump-only admission must not run for external quote");}}) as any;
 const draft=await slrd.tx("wallet").buy(target,sol("0.1"),{maxPriceSol:"1100"}).materializedDraft();
 expect(draft.actions[0]?.meta?.minOutputRaw).toBe("91");
 expect(calls[0]!.slippage).toBe(0);
 expect(calls[1]!.slippage).toBe(0);
 expect(calls[1]!.input).toBe(80n);
});
