import {test,expect} from "bun:test";
import {Keypair,PublicKey} from "@solana/web3.js";
import BN from "bn.js";
import {buyQuoteInput,sellBaseInput} from "@pump-fun/pump-swap-sdk";
import {boundaryReserves} from "./boundary-reserves.ts";
import {boundarySwapState} from "./pumpswap-venue.ts";
import {PumpCurveVenue} from "./pump-curve-venue.ts";
import {SOL_ASSET,sol,toRawAmount} from "../../core/amounts.ts";

test("boundary projection preserves liquidity and conservative side rounding, independent of distant spot",()=>{
  const current={virtualBase:1000000000000n,virtualQuote:100000000000n};
  for(const side of ["buy","sell"] as const){
    const projected=boundaryReserves(current,6,9,"0.0004",side);
    expect(projected).toEqual({virtualBase:500000000000n,virtualQuote:200000000000n});
    expect(current.virtualBase).toBe(1000000000000n);
    const rounded=boundaryReserves(current,6,9,"0.0003333",side);
    const difference=rounded.virtualQuote*10000n-rounded.virtualBase*3333n;
    expect(side==="buy"?difference>=0n:difference<=0n).toBe(true);
  }
  expect(()=>boundaryReserves(current,6,9,"0","buy")).toThrow();
});

test("curve boundary quotes include own impact/fees, not the strict average-price floor",async()=>{
  const venue=new PumpCurveVenue(),mint=Keypair.generate().publicKey;
  const context:any={token:{mint:mint.toBase58(),decimals:6},boundaryPriceQuotePerToken:"0.0004"};
  const market:any={venue:"pump-curve",mint,quoteAsset:SOL_ASSET,metadata:{curve:{virtualBase:1000000000000n,virtualQuote:100000000000n}}};
  const buy=await venue.quoteBuy(context,market,toRawAmount(sol("0.1")),74);
  const sell=await venue.quoteSell(context,market,1000000000n,74);
  expect(buy.minimumOutputRaw).toBeLessThan(250000000n);
  expect(sell.minimumOutputRaw).toBeLessThan(400000000n);
  expect(buy.minimumOutputRaw).toBe(buy.expectedOutputRaw*9926n/10000n);
  expect(sell.minimumOutputRaw).toBe(sell.expectedOutputRaw*9926n/10000n);
  expect(market.metadata.curve.virtualBase).toBe(1000000000000n);
});

test("official PumpSwap fee/impact math receives projected effective reserves without mutating actual state",()=>{
  const state:any={poolBaseAmount:new BN("1000000000000"),poolQuoteAmount:new BN("80000000000"),
    pool:{virtualQuoteReserves:new BN("20000000000")},baseMintAccount:{decimals:6,supply:1000000000000000n}};
  const anchored=boundarySwapState(state,"0.0004",9,"buy");
  expect(anchored.poolBaseAmount.toString()).toBe("500000000000");
  expect(anchored.poolQuoteAmount.toString()).toBe("180000000000");
  expect(state.poolQuoteAmount.toString()).toBe("80000000000");
  const args:any={baseReserve:anchored.poolBaseAmount,quoteReserve:anchored.poolQuoteAmount,
    virtualQuoteReserves:anchored.pool.virtualQuoteReserves,baseMintAccount:anchored.baseMintAccount,
    baseMint:Keypair.generate().publicKey,creator:PublicKey.default,coinCreator:PublicKey.default,feeConfig:null,
    globalConfig:{lpFeeBasisPoints:new BN(30),protocolFeeBasisPoints:new BN(20),coinCreatorFeeBasisPoints:new BN(0)},slippage:0};
  const buy=buyQuoteInput({...args,quote:new BN("100000000")});
  const sell=sellBaseInput({...args,base:new BN("1000000000")});
  expect(BigInt(buy.base.toString())).toBeLessThan(250000000n);
  expect(BigInt(sell.minQuote.toString())).toBeLessThan(400000000n);
  expect(()=>boundarySwapState(state,"1e-20",9,"sell")).toThrow();
});
