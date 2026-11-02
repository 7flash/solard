import {expect,test} from 'bun:test';
import {Keypair} from '@solana/web3.js';
import {buildInitialPumpFeeSharing} from './launch-fee-sharing.ts';

test('initial sharing builds official create and exact 100 percent recipient update',async()=>{
 const creator=Keypair.generate().publicKey,mint=Keypair.generate().publicKey;
 const recipient=Keypair.generate().publicKey;
 const instructions=await buildInitialPumpFeeSharing({creator,mint,shareholders:[{address:recipient.toBase58(),shareBps:10000}]});
 expect(instructions).toHaveLength(2);
 expect(instructions[0]!.keys.some(key=>key.pubkey.equals(creator)&&key.isSigner)).toBe(true);
 const update=instructions[1]!.data;
 expect(update.readUInt32LE(8)).toBe(1);
 expect(update.subarray(12,44).equals(recipient.toBuffer())).toBe(true);
 expect(update.readUInt16LE(44)).toBe(10000);
});

test('initial sharing rejects a non-total allocation before returning instructions',async()=>{
 await expect(buildInitialPumpFeeSharing({creator:Keypair.generate().publicKey,mint:Keypair.generate().publicKey,
  shareholders:[{address:Keypair.generate().publicKey.toBase58(),shareBps:9999}]})).rejects.toThrow();
});
