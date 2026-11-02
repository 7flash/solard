import {expect,test} from "bun:test";
import {PublicKey,type AccountInfo} from "@solana/web3.js";
import {TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {pumpAmmJson} from "@pump-fun/pump-swap-sdk";
import type {TokenRow} from "../db/schema.ts";
import {PUMP_AMM_PROGRAM_ID,PUMP_PROGRAM_ID,WRAPPED_SOL_MINT} from "../venues/pump/constants.ts";
import {PUMP_CURVE_DISCRIMINATOR,decodePool} from "../venues/pump/state.ts";
import {bondingCurvePda} from "../venues/pump/pda.ts";
import {NativePumpBatchPrices} from "./native-pump-batch-prices.ts";
const key=(n:number)=>new PublicKey(new Uint8Array(32).fill(n));
function fixture(){
 const curveMint=key(1),poolMint=key(2),poolAddress=key(3),baseVault=key(4),quoteVault=key(5);
 const accounts=new Map<string,AccountInfo<Buffer>>();let now=10000,calls=0;
 const put=(address:PublicKey,data:Buffer,owner:PublicKey)=>accounts.set(address.toBase58(),{data,owner,executable:false,lamports:1,rentEpoch:0});
 const mint=()=>{const b=Buffer.alloc(82);b[44]=6;b[45]=1;b.writeBigUInt64LE(1_000_000_000_000_000n,36);return b;};
 put(curveMint,mint(),TOKEN_2022_PROGRAM_ID);put(poolMint,mint(),TOKEN_2022_PROGRAM_ID);
 const curve=Buffer.alloc(115);PUMP_CURVE_DISCRIMINATOR.copy(curve);curve.writeBigUInt64LE(1_000_000_000_000n,8);curve.writeBigUInt64LE(1_000_000_000n,16);
 put(bondingCurvePda(curveMint),curve,PUMP_PROGRAM_ID);
 const pool=Buffer.alloc(261);Buffer.from(pumpAmmJson.accounts.find(a=>a.name.toLowerCase()==="pool")!.discriminator).copy(pool);
 poolMint.toBuffer().copy(pool,43);WRAPPED_SOL_MINT.toBuffer().copy(pool,75);baseVault.toBuffer().copy(pool,139);quoteVault.toBuffer().copy(pool,171);pool.writeBigUInt64LE(1_000_000_000n,245);
 put(poolAddress,pool,PUMP_AMM_PROGRAM_ID);
 function vault(mint:PublicKey,amount:bigint){const b=Buffer.alloc(165);mint.toBuffer().copy(b);key(6).toBuffer().copy(b,32);b.writeBigUInt64LE(amount,64);b[108]=1;return b;}
 put(baseVault,vault(poolMint,2_000_000_000_000n),TOKEN_2022_PROGRAM_ID);put(quoteVault,vault(WRAPPED_SOL_MINT,4_000_000_000n),TOKEN_PROGRAM_ID);
 const token=(mint:PublicKey)=>({mint:mint.toBase58(),decimals:6,metadataJson:null} as TokenRow);
 const batch=new NativePumpBatchPrices({getMultipleAccountsInfo:async keys=>{calls++;return keys.map(k=>accounts.get(k.toBase58())??null);}},()=>now);
 batch.add(token(curveMint),TOKEN_2022_PROGRAM_ID);batch.add(token(poolMint),TOKEN_2022_PROGRAM_ID,decodePool(poolAddress,pool));
 return {batch,curveMint,poolMint,poolAddress,baseVault,quoteVault,accounts,curve,pool,put,token,calls:()=>calls,advance:()=>{now+=1001;}};
}
test("coalesces native curve and pool observations into one RPC without changing units or virtual offset",async()=>{
 const f=fixture();const [curve,pool]=await Promise.all([f.batch.read(f.curveMint.toBase58()),f.batch.read(f.poolMint.toBase58())]);
 expect(f.calls()).toBe(1);expect(curve.priceQuotePerToken).toBeCloseTo(.000001,12);expect(pool.priceQuotePerToken).toBeCloseTo(.0000025,12);
 expect(pool.quoteReserveRaw).toBe(5_000_000_000n);expect(pool.capturedAtMs).toBe(10000);
 await f.batch.read(f.curveMint.toBase58());expect(f.calls()).toBe(1);
 f.advance();await f.batch.read(f.poolMint.toBase58());expect(f.calls()).toBe(2);
});
test("a mismatched pool vault cannot change another mint's observed price",async()=>{
 const f=fixture();const info=f.accounts.get(f.baseVault.toBase58())!;key(99).toBuffer().copy(info.data);
 await expect(f.batch.read(f.poolMint.toBase58())).rejects.toThrow("vault mint mismatch");
 expect((await f.batch.read(f.curveMint.toBase58())).priceQuotePerToken).toBeCloseTo(.000001,12);expect(f.calls()).toBe(1);
});
test("vault program and pool discriminator are verified on every batch",async()=>{
 const f=fixture();f.accounts.get(f.baseVault.toBase58())!.owner=TOKEN_PROGRAM_ID;
 await expect(f.batch.read(f.poolMint.toBase58())).rejects.toThrow("program");
 const g=fixture();g.pool[0]^=1;await expect(g.batch.read(g.poolMint.toBase58())).rejects.toThrow("discriminator");
});
test("changed pool quote or vault addresses fail instead of relabeling another asset as SOL",async()=>{
 const f=fixture();key(7).toBuffer().copy(f.pool,75);await expect(f.batch.read(f.poolMint.toBase58())).rejects.toThrow("identity changed");
 const g=fixture();key(7).toBuffer().copy(g.pool,139);await expect(g.batch.read(g.poolMint.toBase58())).rejects.toThrow("identity changed");
});
test("curve migration or a custom quote returns unavailable and leaves pool observations usable",async()=>{
 const f=fixture();f.curve[48]=1;await expect(f.batch.read(f.curveMint.toBase58())).rejects.toThrow("migrated");
 expect((await f.batch.read(f.poolMint.toBase58())).priceQuotePerToken).toBeCloseTo(.0000025,12);
 const g=fixture();key(8).toBuffer().copy(g.curve,83);await expect(g.batch.read(g.curveMint.toBase58())).rejects.toThrow("conversion");
});
test("base decimals come from the initialized mint in the same account batch",async()=>{
 const f=fixture();f.accounts.get(f.curveMint.toBase58())!.data[44]=9;
 expect((await f.batch.read(f.curveMint.toBase58())).priceQuotePerToken).toBeCloseTo(.001,12);
 f.advance();f.accounts.get(f.curveMint.toBase58())!.data[45]=0;
 await expect(f.batch.read(f.curveMint.toBase58())).rejects.toThrow("Uninitialized");
});
test("missing reserves and nonpositive effective reserves never produce a price",async()=>{
 const f=fixture();f.accounts.delete(f.quoteVault.toBase58());await expect(f.batch.read(f.poolMint.toBase58())).rejects.toThrow();
 const g=fixture();g.curve.writeBigUInt64LE(0n,8);await expect(g.batch.read(g.curveMint.toBase58())).rejects.toThrow("Nonpositive");
});
