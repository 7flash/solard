import {test,expect} from 'bun:test';
import {PublicKey,Keypair,type Connection} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {AMM_V4,liquidityStateV4Layout} from '@raydium-io/raydium-sdk-v2';
import {SOL_ASSET} from '../../core/amounts.ts';
import {RaydiumAmmVenue,readRaydiumSolPool,raydiumExactIn} from './amm-venue.ts';
const mint=Keypair.generate().publicKey,pool=Keypair.generate().publicKey,user=Keypair.generate().publicKey;
const authority=PublicKey.findProgramAddressSync([Buffer.from('amm authority')],AMM_V4)[0];
function fixture(){
 const accounts=new Map<string,any>(),data=Buffer.alloc(liquidityStateV4Layout.span),a=Keypair.generate().publicKey,b=Keypair.generate().publicKey;
 const put=(key:PublicKey,data:Buffer,owner=TOKEN_PROGRAM_ID)=>accounts.set(key.toBase58(),{owner,data,lamports:2039280,executable:false,rentEpoch:0});
 for(const [key,value]of Object.entries({status:6,baseDecimal:6,quoteDecimal:9,swapFeeNumerator:25,swapFeeDenominator:10000}))data.writeBigUInt64LE(BigInt(value),liquidityStateV4Layout.offsetOf(key as any));
 for(const [key,value]of Object.entries({baseMint:mint,quoteMint:SOL_ASSET.mint,baseVault:a,quoteVault:b}))value.toBuffer().copy(data,liquidityStateV4Layout.offsetOf(key as any));
 put(pool,data,AMM_V4);
 for(const [key,token,amount]of [[a,mint,100000000000000n],[b,SOL_ASSET.mint,1000000000000n]] as const){const bytes=Buffer.alloc(165);token.toBuffer().copy(bytes);authority.toBuffer().copy(bytes,32);bytes.writeBigUInt64LE(amount,64);bytes[108]=1;put(key,bytes);}
 for(const [key,decimals]of [[mint,6],[SOL_ASSET.mint,9]] as const){const bytes=Buffer.alloc(82);bytes.writeBigUInt64LE(1000000000000000n,36);bytes[44]=decimals;bytes[45]=1;put(key,bytes);}
 const connection={getAccountInfo:async(key:PublicKey)=>accounts.get(key.toBase58())??null,getMultipleAccountsInfo:async(keys:PublicKey[])=>keys.map(k=>accounts.get(k.toBase58())??null),getMinimumBalanceForRentExemption:async()=>2039280} as unknown as Connection;
 return {accounts,data,a,b,connection,ctx:{connection,user,token:{mint:mint.toBase58(),venueHint:'raydium-amm',pool:pool.toBase58()} as any}};
}
test('Raydium quotes subtract PNL and round input fee upwards',async()=>{
 const f=fixture();f.data.writeBigUInt64LE(100n,liquidityStateV4Layout.offsetOf('baseNeedTakePnl'));
 const d=await readRaydiumSolPool(f.connection,pool,mint);
 expect(d.reserves.virtualBase).toBe(99999999999900n);
 expect(raydiumExactIn(1001n,10000n,100000n,25n,10000n)).toBe(9074n);
 const venue=new RaydiumAmmVenue(),m=(await venue.resolveMarket(f.ctx))!;
 const q=await venue.quoteBuy(f.ctx,m,{asset:SOL_ASSET,raw:10000000n},50);
 expect(q.minimumOutputRaw).toBe(q.expectedOutputRaw*9950n/10000n);
 expect((await venue.price(f.ctx,m)).capturedAtMs).toBeLessThanOrEqual(Date.now());
});
test('exact-input buy and sell encode floors and isolate temporary SOL from unrelated accounts',async()=>{
 const f=fixture(),venue=new RaydiumAmmVenue(),m=(await venue.resolveMarket(f.ctx))!;
 for(const buy of [true,false]){
  const quote={venue:venue.id,quoteAsset:SOL_ASSET,inputRaw:10000000n,expectedOutputRaw:100n,minimumOutputRaw:99n};
  const built=await(buy?venue.buildBuy(f.ctx,m,quote):venue.buildSell(f.ctx,m,quote));
  const swap=built.instructions[3]!,close=built.instructions[4]!;
  expect(swap.programId.equals(AMM_V4)).toBe(true);expect(swap.data[0]).toBe(16);
  expect(swap.data.readBigUInt64LE(1)).toBe(quote.inputRaw);expect(swap.data.readBigUInt64LE(9)).toBe(99n);
  expect(close.keys[0]!.pubkey.equals(swap.keys[buy?5:6]!.pubkey)).toBe(true);
  expect(swap.keys[7]!.pubkey.equals(user)).toBe(true);
 }
});
test('wrong mint, vault, owner, program, decimals, status and exhausted reserves fail closed',async()=>{
 for(const mutation of ['program','mint','authority','decimals','status','pnl']){
  const f=fixture();
  if(mutation==='program')f.accounts.get(f.a.toBase58()).owner=AMM_V4;
  if(mutation==='mint')Keypair.generate().publicKey.toBuffer().copy(f.accounts.get(f.a.toBase58()).data);
  if(mutation==='authority')user.toBuffer().copy(f.accounts.get(f.a.toBase58()).data,32);
  if(mutation==='decimals')f.accounts.get(mint.toBase58()).data[44]=9;
  if(mutation==='status')f.data.writeBigUInt64LE(2n,0);
  if(mutation==='pnl')f.data.writeBigUInt64LE(100000000000000n,liquidityStateV4Layout.offsetOf('baseNeedTakePnl'));
  await expect(readRaydiumSolPool(f.connection,pool,mint)).rejects.toThrow();
 }
});
