import {expect,test}from"bun:test";
import {excludeWalletGroups}from"./wallet-group-filter.ts";
test("group exclusion handles overlapping memberships and virtual ungrouped without hiding unknown groups",()=>{
 const wallets=[{address:"a"},{address:"b"},{address:"c"}];const memberships=[{groupName:"oct23-empty",walletAddress:"a"},{groupName:"default",walletAddress:"a"},{groupName:"keep",walletAddress:"b"}];const known=new Set(["oct23-empty","default","keep","empty"]);
 expect(excludeWalletGroups(wallets,["oct23-empty"],memberships,known)).toEqual([{address:"b"},{address:"c"}]);
 expect(excludeWalletGroups(wallets,["ungrouped"],memberships,known)).toEqual([{address:"a"},{address:"b"}]);
 expect(excludeWalletGroups(wallets,["oct23-empty","keep"],memberships,known)).toEqual([{address:"c"}]);
 expect(excludeWalletGroups(wallets,["empty"],memberships,known)).toEqual(wallets);
 expect(()=>excludeWalletGroups(wallets,["typo"],memberships,known)).toThrow("Unknown excluded");
});
