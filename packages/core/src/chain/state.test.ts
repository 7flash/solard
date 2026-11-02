import { test, expect } from "bun:test";
import { Keypair, SystemProgram, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MintLayout, MINT_SIZE } from "@solana/spl-token";
import { readMint, readTokenAmount } from "./state.ts";

test("balance read distinguishes a missing ATA from quota, network and owner failures", async () => {
 const owner=Keypair.generate().publicKey,mint=Keypair.generate().publicKey;
 const missing={getAccountInfo:async()=>null} as unknown as Connection;
 expect(await readTokenAmount(missing,owner,mint,TOKEN_PROGRAM_ID)).toBe(0n);
 for(const message of ['429 quota exceeded','fetch failed','RPC_PROVIDER_UNAVAILABLE']){
  const failure=new Error(message),connection={getAccountInfo:async()=>{throw failure;}} as unknown as Connection;
  await expect(readTokenAmount(connection,owner,mint,TOKEN_PROGRAM_ID)).rejects.toBe(failure);
 }
 const wrongOwner={getAccountInfo:async()=>({owner:SystemProgram.programId,data:Buffer.alloc(165)})} as unknown as Connection;
 await expect(readTokenAmount(wrongOwner,owner,mint,TOKEN_PROGRAM_ID)).rejects.toThrow();
});

test("uncached verified mint supply and decimals require one read for either token program", async () => {
 for(const program of [TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID]) {
  const mint=Keypair.generate().publicKey,data=Buffer.alloc(MINT_SIZE);let calls=0;
  MintLayout.encode({mintAuthorityOption:0,mintAuthority:mint,supply:935703758312669n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:mint},data);
  const connection={getAccountInfo:async()=>{calls++;return {owner:program,data,lamports:1,executable:false,rentEpoch:0};}} as unknown as Connection;
  expect(await readMint(connection,mint)).toMatchObject({tokenProgram:program,decimals:6,supply:935703758312669n});
  expect(calls).toBe(1);
 }
});
