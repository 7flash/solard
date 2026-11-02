import { PublicKey } from "@solana/web3.js";
import type { Solard } from "../core/solard.ts";
import type { TokenRow } from "../db/schema.ts";
import type { WalletTokenHolding } from "./portfolio.ts";
import { createSolardMeasure } from "../core/log.ts";
import { measured } from "../core/measured.ts";
const m=createSolardMeasure("liquidation-route");
/** Existing pool hints avoid unrelated protocol scans; venue resolution still verifies live state. */
export async function resolveLiquidationMarket(slrd:Solard,holding:WalletTokenHolding){
 return await measured(m,`resolve ${holding.mint}`,async()=>{
  const mint=new PublicKey(holding.mint);
  let known:TokenRow|undefined;
  try{known=slrd.resolveToken(mint);}catch(error){if((error as {code?:string}).code!=="UNKNOWN_TOKEN")throw error;}
  const inspected=known&&(known.pool||known.bondingCurve||known.venueHint==="jupiter")?known
   :holding.mint==="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"?{venueHint:"jupiter" as const}
   :await slrd.venues.inspect(slrd.connection(),mint);
  const token={...(inspected??{}),mint:holding.mint,decimals:holding.decimals,baseTokenProgram:holding.programId} as TokenRow;
  const routed=await slrd.route(token,PublicKey.default);
  return{token,venue:String(routed.market.venue)};
 },value=>({venue:value.venue,mint:holding.mint}));
}
