import {PublicKey,type Connection,type AccountInfo} from "@solana/web3.js";
import {unpackAccount,unpackMint,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID} from "@solana/spl-token";
import {pumpAmmJson} from "@pump-fun/pump-swap-sdk";
import {SOL_ASSET} from "../core/amounts.ts";
import type {TokenRow} from "../db/schema.ts";
import type {MarketPrice} from "../venues/venue-plugin.ts";
import {PUMP_AMM_PROGRAM_ID,PUMP_PROGRAM_ID,WRAPPED_SOL_MINT} from "../venues/pump/constants.ts";
import {decodeCurve,decodePool,type PumpPool} from "../venues/pump/state.ts";
import {bondingCurvePda} from "../venues/pump/pda.ts";
import {spotPriceQuotePerToken} from "../venues/pump/quote.ts";
type Entry={token:TokenRow;program:PublicKey;pool?:PumpPool};
const discriminator=Buffer.from(pumpAmmJson.accounts.find(a=>a.name.toLowerCase()==="pool")!.discriminator);
export class NativePumpBatchPrices{
  private entries=new Map<string,Entry>();
  private values=new Map<string,MarketPrice|Error>();
  private pending?:Promise<void>;
  private started=-Infinity;
  constructor(private connection:Pick<Connection,"getMultipleAccountsInfo">,private now=Date.now){}
  add(token:TokenRow,program:PublicKey,pool?:PumpPool){
    if(!Number.isInteger(token.decimals)||token.decimals!<0||token.decimals!>18||
      ![TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>p.equals(program)))throw Error("Verified base mint identity required");
    if(pool&&(!pool.baseMint.equals(new PublicKey(token.mint))||!pool.quoteMint.equals(WRAPPED_SOL_MINT)))throw Error("Native pool identity mismatch");
    this.entries.set(token.mint,{token,program,pool});this.started=-Infinity;
  }
  has(mint:string){return this.entries.has(mint);}
  remove(mint:string){this.entries.delete(mint);this.values.delete(mint);}
  async read(mint:string):Promise<MarketPrice>{
    if(!this.entries.has(mint))throw Error("Market is not registered in native batch sampler");
    if(!this.pending&&this.now()-this.started>=1000){
      this.started=this.now();
      this.pending=this.refresh(this.started).finally(()=>{this.pending=undefined;});
    }
    if(this.pending)await this.pending;
    const value=this.values.get(mint);if(!value||value instanceof Error)throw value??Error("Market price unavailable");return value;
  }
  private async refresh(at:number){
    const entries=[...this.entries.values()],addresses=new Map<string,PublicKey>();
    for(const e of entries)for(const address of [new PublicKey(e.token.mint),...(e.pool?[e.pool.address,e.pool.baseTokenAccount,e.pool.quoteTokenAccount]:[bondingCurvePda(new PublicKey(e.token.mint))])])addresses.set(address.toBase58(),address);
    const keys=[...addresses.values()],infos=await this.connection.getMultipleAccountsInfo(keys,"confirmed");
    if(infos.length!==keys.length)throw Error("Incomplete native price batch");
    const accounts=new Map(keys.map((key,i)=>[key.toBase58(),infos[i]]));
    const account=(key:PublicKey,program:PublicKey):AccountInfo<Buffer>=>{
      const info=accounts.get(key.toBase58());if(!info||!info.owner.equals(program))throw Error("Missing or changed market account program");return info;
    };
    const values=new Map<string,MarketPrice|Error>();
    for(const entry of entries)try{
      const mint=new PublicKey(entry.token.mint),mintState=unpackMint(mint,account(mint,entry.program),entry.program);
      if(!mintState.isInitialized)throw Error("Uninitialized base mint");
      let base:bigint,quote:bigint;
      if(entry.pool){
        const old=entry.pool,info=account(old.address,PUMP_AMM_PROGRAM_ID);
        if(!Buffer.from(info.data).subarray(0,8).equals(discriminator))throw Error("Invalid PumpSwap discriminator");
        const pool=decodePool(old.address,Buffer.from(info.data));
        if(!pool.baseMint.equals(mint)||!pool.quoteMint.equals(WRAPPED_SOL_MINT)||!pool.baseTokenAccount.equals(old.baseTokenAccount)||!pool.quoteTokenAccount.equals(old.quoteTokenAccount))throw Error("PumpSwap market identity changed");
        const b=unpackAccount(pool.baseTokenAccount,account(pool.baseTokenAccount,entry.program),entry.program);
        const q=unpackAccount(pool.quoteTokenAccount,account(pool.quoteTokenAccount,TOKEN_PROGRAM_ID),TOKEN_PROGRAM_ID);
        if(!b.mint.equals(mint)||!q.mint.equals(WRAPPED_SOL_MINT))throw Error("PumpSwap vault mint mismatch");
        base=b.amount;quote=q.amount+pool.virtualQuoteReserves;
      }else{
        const address=bondingCurvePda(mint),curve=decodeCurve(address,Buffer.from(account(address,PUMP_PROGRAM_ID).data),entry.token);
        if(curve.complete)throw Error("Curve migrated; market rediscovery required");
        if(curve.quoteAsset.kind!=="native-sol")throw Error("Curve quote changed; verified conversion required");
        base=curve.virtualBase;quote=curve.virtualQuote;
      }
      if(base<=0n||quote<=0n)throw Error("Nonpositive verified reserves");
      const price=spotPriceQuotePerToken({virtualBase:base,virtualQuote:quote},mintState.decimals,9);
      if(!Number.isFinite(price)||price<=0)throw Error("Invalid reserve price");
      values.set(entry.token.mint,{venue:entry.pool?"pumpswap":"pump-curve",mint,quoteAsset:SOL_ASSET,
        priceQuotePerToken:price,baseReserveRaw:base,quoteReserveRaw:quote,capturedAtMs:at});
    }catch(e){values.set(entry.token.mint,e instanceof Error?e:Error(String(e)));}
    this.values=values;
  }
}
