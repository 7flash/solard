export function excludeWalletGroups<T extends { address: string }>(
 wallets:T[], names:string[], memberships:ReadonlyArray<{groupName:string;walletAddress:string}>, knownGroups:ReadonlySet<string>,
):T[] {
 const grouped=new Set(memberships.filter(row=>row.groupName.toLowerCase()!=="ungrouped").map(row=>row.walletAddress));
 const excluded=new Set<string>();
 for(const name of names){
  if(name.toLowerCase()==="ungrouped"){for(const wallet of wallets)if(!grouped.has(wallet.address))excluded.add(wallet.address);continue;}
  if(!knownGroups.has(name))throw Error(`Unknown excluded wallet group: ${name}`);
  for(const row of memberships)if(row.groupName===name)excluded.add(row.walletAddress);
 }
 return wallets.filter(wallet=>!excluded.has(wallet.address));
}
