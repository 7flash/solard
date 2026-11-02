import{expect,test}from"bun:test";
import{Keypair}from"@solana/web3.js";
import{TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID}from"@solana/spl-token";
import{resolveLiquidationMarket}from"./liquidation-routing.ts";
test("liquidation reuses known external quote route but preserves chain-verified mint metadata",async()=>{
 const mint=Keypair.generate().publicKey.toBase58();let inspections=0,resolutions=0;
 const host={resolveToken:()=>({mint,venueHint:"jupiter",decimals:9,baseTokenProgram:TOKEN_PROGRAM_ID.toBase58()}),
  connection:()=>({}),venues:{inspect:async()=>{inspections++;throw Error("unrelated native scan");}},route:async(token:any)=>{resolutions++;expect(token.decimals).toBe(8);expect(token.baseTokenProgram).toBe(TOKEN_2022_PROGRAM_ID.toBase58());return{market:{venue:"jupiter"}};}};
 const result=await resolveLiquidationMarket(host as any,{mint,decimals:8,programId:TOKEN_2022_PROGRAM_ID.toBase58()} as any);
 expect(result.venue).toBe("jupiter");expect(inspections).toBe(0);expect(resolutions).toBe(1);
 host.resolveToken=()=>{throw Object.assign(Error("provider unavailable"),{code:"RPC_PROVIDER_UNAVAILABLE"});};
 await expect(resolveLiquidationMarket(host as any,{mint} as any)).rejects.toThrow("provider unavailable");
});
test("canonical USDC liquidation bypasses unrelated native discovery even before token registration",async()=>{
 let inspections=0;
 const host={resolveToken:()=>{throw Object.assign(Error("unknown"),{code:"UNKNOWN_TOKEN"});},connection:()=>({}),venues:{inspect:async()=>{inspections++;throw Error("unrelated");}},route:async(token:any)=>{expect(token.venueHint).toBe("jupiter");return{market:{venue:"jupiter"}};}};
 expect((await resolveLiquidationMarket(host as any,{mint:"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",decimals:6,programId:TOKEN_PROGRAM_ID.toBase58()} as any)).venue).toBe("jupiter");expect(inspections).toBe(0);
});
