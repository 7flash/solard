import type { RangeSpec } from "./market-cap-band.ts";
import { readFileSync, watch } from "fs";
import { basename, dirname, resolve } from "path";
import { fixedPriceBand, positivePrice, type FixedPriceBand } from "./fixed-price-band.ts";
/** Bid-ask steps in the range: 1 (default) = one buy level + one sell level, N = N equal rungs. */
export function parseRangeSteps(text: string): number {
 const value=JSON.parse(text);
 const steps=value?.steps??1;
 if(!Number.isInteger(steps)||steps<1||steps>20)throw new Error("steps must be an integer 1..20");
 return steps;
}
export function parseRangeFile(text: string): RangeSpec {
 const value=JSON.parse(text);
 if(!value || typeof value!=="object" || Array.isArray(value))throw new Error("Invalid range config");
 parseRangeSteps(text);
 const keys=Object.keys(value).filter(k=>k!=="steps");
 if(keys.length===2 && keys.every(k=>["buyPriceSol","sellPriceSol"].includes(k)) && typeof value.buyPriceSol==="string" && typeof value.sellPriceSol==="string")
  return fixedPriceBand(value.buyPriceSol,value.sellPriceSol);
 if(keys.length===2 && keys.every(k=>["buyMarketCapUsd","sellMarketCapUsd"].includes(k)) && typeof value.buyMarketCapUsd==="string" && typeof value.sellMarketCapUsd==="string"){
  positivePrice(value.buyMarketCapUsd);positivePrice(value.sellMarketCapUsd);
  return {kind:"market-cap",buyMarketCapUsd:value.buyMarketCapUsd,sellMarketCapUsd:value.sellMarketCapUsd,
   ...(Number(value.sellMarketCapUsd)<=Number(value.buyMarketCapUsd)?{entryPaused:true as const}:{})};
 }
 throw new Error("Range requires either buyPriceSol/sellPriceSol or buyMarketCapUsd/sellMarketCapUsd as decimal strings");
}
/** Watch the directory to survive editors replacing the file by atomic rename. */
export function watchRangeFile(path: string, changed: (band: RangeSpec | null, error?: string) => void, parse: (text: string) => RangeSpec = parseRangeFile) {
 const absolute=resolve(path);let current=parse(readFileSync(absolute,"utf8"));
 let valid=true, closed=false, previous=JSON.stringify(current), timer:ReturnType<typeof setTimeout>|undefined;
 const refresh=()=>{
  if(closed)return;
  try{const next=parse(readFileSync(absolute,"utf8"));const encoded=JSON.stringify(next);
   if(!valid||encoded!==previous){current=next;previous=encoded;valid=true;changed(next);}
  }catch(error){if(valid){valid=false;changed(null,error instanceof Error?error.message:String(error));}}
 };
 const watcher=watch(dirname(absolute), (_event, name)=>{
  if(name!=null&&String(name)!==basename(absolute))return;
  clearTimeout(timer);timer=setTimeout(refresh,75);
 });
 watcher.on("error", error=>{valid=false;changed(null,String(error));});
 return {get current(){return current;},get valid(){return valid;},refresh,
  close(){closed=true;clearTimeout(timer);watcher.close();}};
}
