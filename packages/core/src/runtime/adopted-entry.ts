/** Imported acquisition evidence is separate from bot execution records. */
export function adoptedEntry(input: unknown, wallet: string, mint: string) {
  const e=input as Record<string,unknown>;
  if(!e||e.source!=="confirmed-chain-acquisition"||e.wallet!==wallet||e.mint!==mint||
    typeof e.signature!=="string"||!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(e.signature)||
    typeof e.atMs!=="number"||!Number.isFinite(e.atMs)||e.atMs<=0||
    ![e.amountRaw,e.costLamports,e.networkFeeLamports].every(x=>typeof x==="string"&&/^\d+$/.test(x)))throw Error("Invalid adopted acquisition evidence");
  const amount=BigInt(e.amountRaw as string),cost=BigInt(e.costLamports as string),fee=BigInt(e.networkFeeLamports as string);
  if(amount<=0n||cost<=fee)throw Error("Invalid adopted acquisition amounts");
  return {side:"buy",time:e.atMs,signature:e.signature,tokens:amount.toString(),principal:(fee-cost).toString(),fee:fee.toString(),
    note:"Imported confirmed acquisition; entry cost is observed wallet outlay excluding token-account rent"};
}
