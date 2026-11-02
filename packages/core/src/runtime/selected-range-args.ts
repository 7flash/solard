import {PublicKey} from "@solana/web3.js";

/** Explicit selection only: adding a CSV row alone must not revive historical bots. */
export function selectedRangeRuns(argv: readonly string[]): string[][] {
  const value=(flag:string)=>{const i=argv.indexOf(flag);if(i<0||!argv[i+1]||argv[i+1]!.startsWith("--"))throw Error(`Missing ${flag}`);return argv[i+1]!;};
  const first=value("--mint"),additional:string[]=[];
  new PublicKey(first);
  for(let i=0;i<argv.length;i++)if(argv[i]==="--also-mint"){
    const mint=argv[++i];if(!mint||mint.startsWith("--"))throw Error("Missing --also-mint");
    new PublicKey(mint);additional.push(mint);
  }
  if(new Set([first,...additional]).size!==additional.length+1)throw Error("Selected mints must be distinct");
  if(additional.length>7)throw Error("At most eight explicit selections are supported");
  const base:string[]=[];
  for(let i=0;i<argv.length;i++){
    if(argv[i]==="--also-mint"){i++;continue;}
    if(argv[i]==="--live"||argv[i]==="--probe-only")continue;
    base.push(argv[i]!);
  }
  const result=[base];
  for(const mint of additional){const extra=[...base];extra[extra.indexOf("--mint")+1]=mint;result.push(extra);}
  return result;
}

/** Account reads and the SDK must use the same endpoint after readiness fallback. */
export function selectedRangeRpc(argv:readonly string[],endpoint:string):string[]{
  const result=[...argv],i=result.indexOf("--rpc-url");
  if(i>=0)result[i+1]=endpoint;else result.push("--rpc-url",endpoint);
  return result;
}

export function selectedPublicRpcPool(endpoint:string):string[]{
  const publicUrls=["https://api.mainnet-beta.solana.com/","https://solana-rpc.publicnode.com/"];
  const normalized=new URL(endpoint).toString();
  return publicUrls.includes(normalized)?[endpoint,...publicUrls.filter(url=>url!==normalized)]:[endpoint];
}
