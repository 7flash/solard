import {PublicKey,SystemProgram,type Connection,type TransactionInstruction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,ACCOUNT_SIZE,unpackAccount,unpackMint,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createInitializeAccount3Instruction,createCloseAccountInstruction} from '@solana/spl-token';
import {AMM_V4,liquidityStateV4Layout,swapBaseInV2Instruction,type LiquidityStateV4} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import {SOL_ASSET,type RawAmount} from '../../core/amounts.ts';
import {boundaryReserves} from '../pump/boundary-reserves.ts';
import {spotPriceQuotePerToken} from '../pump/quote.ts';
import type {TradeVenuePlugin,VenueContext,VenueMarket,QuoteResult,MarketPrice,BuiltInstructions} from '../venue-plugin.ts';

const authority=PublicKey.findProgramAddressSync([Buffer.from('amm authority')],AMM_V4)[0];
export type RaydiumSolPool={pool:PublicKey;state:LiquidityStateV4;at:number;decimals:number;supply:bigint;reserves:{virtualBase:bigint;virtualQuote:bigint};feeNumerator:bigint;feeDenominator:bigint};
export async function readRaydiumSolPool(connection:Connection,pool:PublicKey,mint:PublicKey):Promise<RaydiumSolPool>{
 const at=Date.now(),info=await connection.getAccountInfo(pool,'confirmed');
 if(!info||!info.owner.equals(AMM_V4)||info.data.length!==liquidityStateV4Layout.span)throw Error('Invalid Raydium AMM v4 pool');
 const state=liquidityStateV4Layout.decode(info.data);
 if(![1,6].includes(state.status.toNumber())||state.poolOpenTime.toNumber()>Math.floor(Date.now()/1000))throw Error('Raydium pool is not open for swaps');
 const reversed=state.quoteMint.equals(mint);
 if(!(reversed?state.baseMint.equals(SOL_ASSET.mint):state.baseMint.equals(mint)&&state.quoteMint.equals(SOL_ASSET.mint)))throw Error('Raydium base/quote identity mismatch');
 const keys=[state.baseVault,state.quoteVault,state.baseMint,state.quoteMint];
 const infos=await connection.getMultipleAccountsInfo(keys,'confirmed');
 if(infos.length!==4||infos.some(x=>!x?.owner.equals(TOKEN_PROGRAM_ID)))throw Error('Raydium vault/mint program mismatch');
 const a=unpackAccount(keys[0]!,infos[0]!,TOKEN_PROGRAM_ID),b=unpackAccount(keys[1]!,infos[1]!,TOKEN_PROGRAM_ID);
 if(!a.mint.equals(state.baseMint)||!b.mint.equals(state.quoteMint)||!a.owner.equals(authority)||!b.owner.equals(authority))throw Error('Raydium vault identity mismatch');
 const ma=unpackMint(keys[2]!,infos[2]!,TOKEN_PROGRAM_ID),mb=unpackMint(keys[3]!,infos[3]!,TOKEN_PROGRAM_ID);
 if(!ma.isInitialized||!mb.isInitialized||ma.decimals!==state.baseDecimal.toNumber()||mb.decimals!==state.quoteDecimal.toNumber())throw Error('Raydium mint decimals mismatch');
 const reserveA=a.amount-BigInt(state.baseNeedTakePnl.toString()),reserveB=b.amount-BigInt(state.quoteNeedTakePnl.toString());
 if(reserveA<=0n||reserveB<=0n)throw Error('Raydium reserves unavailable');
 const feeNumerator=BigInt(state.swapFeeNumerator.toString()),feeDenominator=BigInt(state.swapFeeDenominator.toString());
 if(feeDenominator<=0n||feeNumerator<0n||feeNumerator>=feeDenominator)throw Error('Invalid Raydium swap fee');
 return {pool,state,at,decimals:reversed?mb.decimals:ma.decimals,supply:reversed?mb.supply:ma.supply,
  reserves:{virtualBase:reversed?reserveB:reserveA,virtualQuote:reversed?reserveA:reserveB},feeNumerator,feeDenominator};
}
type Pool=Awaited<ReturnType<typeof readRaydiumSolPool>>;
export function raydiumExactIn(input:bigint,reserveIn:bigint,reserveOut:bigint,numerator:bigint,denominator:bigint){
 if(input<=0n||reserveIn<=0n||reserveOut<=0n||numerator<0n||denominator<=numerator)throw Error('Invalid Raydium exact input');
 const fee=(input*numerator+denominator-1n)/denominator,net=input-fee;
 if(net<=0n)throw Error('Raydium input consumed by fee');
 return net*reserveOut/(reserveIn+net);
}
/** Explicitly configured, legacy SPL-token / SOL AMM v4 markets only. */
export class RaydiumAmmVenue implements TradeVenuePlugin{
 readonly id='raydium-amm';
 async resolveMarket(ctx:VenueContext):Promise<VenueMarket|null>{
  if(ctx.token.venueHint!==this.id||!ctx.token.pool)return null;
  const data=await readRaydiumSolPool(ctx.connection,new PublicKey(ctx.token.pool),new PublicKey(ctx.token.mint));
  return {venue:this.id,mint:new PublicKey(ctx.token.mint),quoteAsset:SOL_ASSET,baseTokenProgram:TOKEN_PROGRAM_ID,creator:null,
   metadata:{pool:data.pool,baseDecimals:data.decimals,data}};
 }
 async price(_ctx:VenueContext,market:VenueMarket):Promise<MarketPrice>{
  const d=market.metadata.data as Pool;
  return {venue:this.id,mint:market.mint,quoteAsset:SOL_ASSET,priceQuotePerToken:spotPriceQuotePerToken(d.reserves,d.decimals,9),
   baseReserveRaw:d.reserves.virtualBase,quoteReserveRaw:d.reserves.virtualQuote,capturedAtMs:d.at};
 }
 private quote(ctx:VenueContext,market:VenueMarket,input:bigint,buy:boolean,bps:number):QuoteResult{
  if(!Number.isInteger(bps)||bps<0||bps>=10000)throw Error('Invalid Raydium slippage');
  const d=market.metadata.data as Pool,r=ctx.boundaryPriceQuotePerToken==null?d.reserves:boundaryReserves(d.reserves,d.decimals,9,ctx.boundaryPriceQuotePerToken,buy?'buy':'sell');
  const expected=raydiumExactIn(input,buy?r.virtualQuote:r.virtualBase,buy?r.virtualBase:r.virtualQuote,d.feeNumerator,d.feeDenominator);
  const minimum=expected*BigInt(10000-bps)/10000n;if(minimum<=0n)throw Error('Raydium minimum is zero');
  return {venue:this.id,quoteAsset:SOL_ASSET,inputRaw:input,expectedOutputRaw:expected,minimumOutputRaw:minimum};
 }
 async quoteBuy(ctx:VenueContext,market:VenueMarket,amount:RawAmount,bps:number){if(amount.asset.kind!=='native-sol')throw Error('Raydium buy requires SOL');return this.quote(ctx,market,amount.raw,true,bps);}
 async quoteSell(ctx:VenueContext,market:VenueMarket,amount:bigint,bps:number){return this.quote(ctx,market,amount,false,bps);}
 private async build(ctx:VenueContext,market:VenueMarket,q:QuoteResult,buy:boolean):Promise<BuiltInstructions>{
  const d=market.metadata.data as Pool;
  if(q.inputRaw<=0n||q.minimumOutputRaw<=0n||q.inputRaw>0xffffffffffffffffn||q.minimumOutputRaw>0xffffffffffffffffn)throw Error('Raydium swap amounts must be positive u64');
  const seed=crypto.randomUUID().replaceAll('-',''),temporary=await PublicKey.createWithSeed(ctx.user,seed,TOKEN_PROGRAM_ID);
  const rent=await ctx.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE,'confirmed');
  if(!Number.isSafeInteger(rent)||rent<=0)throw Error('Raydium temporary account rent unavailable');
  const funding=BigInt(rent)+(buy?q.inputRaw:0n);if(funding>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Raydium funding exceeds safe lamports');
  const target=getAssociatedTokenAddressSync(market.mint,ctx.user,false,TOKEN_PROGRAM_ID);
  const instructions:TransactionInstruction[]=[SystemProgram.createAccountWithSeed({fromPubkey:ctx.user,basePubkey:ctx.user,seed,newAccountPubkey:temporary,lamports:Number(funding),space:ACCOUNT_SIZE,programId:TOKEN_PROGRAM_ID}),
   createInitializeAccount3Instruction(temporary,SOL_ASSET.mint,ctx.user,TOKEN_PROGRAM_ID),
   createAssociatedTokenAccountIdempotentInstruction(ctx.user,target,ctx.user,market.mint,TOKEN_PROGRAM_ID),
   swapBaseInV2Instruction(AMM_V4,d.pool,authority,d.state.baseVault,d.state.quoteVault,buy?temporary:target,buy?target:temporary,ctx.user,new BN(q.inputRaw.toString()),new BN(q.minimumOutputRaw.toString())),
   createCloseAccountInstruction(temporary,ctx.user,ctx.user,[],TOKEN_PROGRAM_ID)];
  return {venue:this.id,quoteAsset:SOL_ASSET,instructions,minOutputRaw:q.minimumOutputRaw,expectedOutputRaw:q.expectedOutputRaw,meta:{pool:d.pool.toBase58()}};
 }
 buildBuy(ctx:VenueContext,m:VenueMarket,q:QuoteResult){return this.build(ctx,m,q,true);}
 buildSell(ctx:VenueContext,m:VenueMarket,q:QuoteResult){return this.build(ctx,m,q,false);}
}
