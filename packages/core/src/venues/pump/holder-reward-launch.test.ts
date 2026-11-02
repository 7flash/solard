import {expect,test,spyOn} from 'bun:test';
import {Keypair,type Connection} from '@solana/web3.js';
import {OnlinePumpSdk,holderRewardsPda} from '@pump-fun/pump-sdk';
import {PumpTokenLaunchpad} from './pump-launchpad.ts';

test('holder-reward deployment uses official creation flag and reward PDA for future trades',async()=>{
 const global=spyOn(OnlinePumpSdk.prototype,'fetchGlobal').mockResolvedValue({isHolderRewardEnabled:true} as Awaited<ReturnType<OnlinePumpSdk['fetchGlobal']>>);
 try{
  const mint=Keypair.generate(),user=Keypair.generate().publicKey;
  const deployment=await new PumpTokenLaunchpad().prepareDeployment({} as Connection,{mint,user,name:'Holder',symbol:'H',uri:'https://example.test/meta',holderReward:true});
  expect(deployment.creator.equals(holderRewardsPda(mint.publicKey))).toBe(true);
  expect(deployment.metadata?.holderReward).toBe(true);
  expect(deployment.instructions[0]!.data.at(-1)).toBe(1);
  expect(deployment.token.creator).toBe(deployment.creator.toBase58());
 }finally{global.mockRestore();}
});

test('holder-reward deployment rejects disabled protocol gate',async()=>{
 const global=spyOn(OnlinePumpSdk.prototype,'fetchGlobal').mockResolvedValue({isHolderRewardEnabled:false} as Awaited<ReturnType<OnlinePumpSdk['fetchGlobal']>>);
 try{
  await expect(new PumpTokenLaunchpad().prepareDeployment({} as Connection,{user:Keypair.generate().publicKey,name:'Holder',symbol:'H',uri:'https://example.test/meta',holderReward:true})).rejects.toThrow('disabled');
 }finally{global.mockRestore();}
});
