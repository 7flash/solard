import {afterEach,expect,test} from 'bun:test';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rmSync} from 'node:fs';
import {Keypair} from '@solana/web3.js';
import {Solard} from '../core/solard.ts';
import {ignoreZeroSolWallets} from '../chain/ignore-zero-sol-wallets.ts';
const paths:string[]=[];
const cores:Solard[]=[];
function core(){const path=join(tmpdir(),`wallet-ignore-${process.pid}-${crypto.randomUUID()}.sqlite`);paths.push(path);const s=new Solard({dbPath:path});cores.push(s);return s;}
function wallet(s:Solard,name:string){return s.db.wallets.insert({name,address:Keypair.generate().publicKey.toBase58(),encryptedSecretKey:'unchanged-ciphertext',nonce:'nonce',authTag:'tag',isActive:1,createdAtMs:1,updatedAtMs:1});}
afterEach(()=>{for(const s of cores.splice(0))s.close();for(const p of paths.splice(0))for(const suffix of ['', '-wal','-shm'])rmSync(p+suffix,{force:true});});
test('ignore persists without losing encrypted keys or memberships, restores, and filters groups',()=>{
 const s=core(),a=wallet(s,'a'),b=wallet(s,'b');s.groups.create('test');s.groups.addWallet('test',a.address);s.groups.addWallet('test',b.address);
 s.ignoreWallet('a');
 expect(s.listWallets().map(w=>w.name)).toEqual(['b']);
 expect(s.listWallets({ignoredOnly:true}).map(w=>w.name)).toEqual(['a']);
 expect(s.listWallets({includeIgnored:true})).toHaveLength(2);
 expect(s.groupWallets('test')).toEqual([b.address]);
 expect(s.db.wallets.select().where({id:a.id}).first()!.encryptedSecretKey).toBe('unchanged-ciphertext');
 expect(s.groups.wallets('test')).toHaveLength(2);
 expect(s.resolveWallet('a').address.toBase58()).toBe(a.address);
 const reopened=new Solard({dbPath:paths.at(-1)!});cores.push(reopened);
 expect(reopened.listWallets()).toHaveLength(1);
 reopened.unignoreWallet(a.address);expect(s.listWallets()).toHaveLength(2);
 expect(()=>s.ignoreWallet('absent')).toThrow('Unknown wallet');
});
test('zero-SOL classification batches reads, excludes ignored wallets and keeps one lamport',async()=>{
 const s=core();for(let i=0;i<102;i++)wallet(s,`w${i}`);s.ignoreWallet('w101');let calls=0;
 const result=await ignoreZeroSolWallets(s.wallets,{getMultipleAccountsInfoAndContext:async(addresses:any[])=>{calls++;expect(addresses.length).toBeLessThanOrEqual(100);return {context:{slot:42},value:addresses.map((_:any,index:number)=>calls===1&&index===0?{lamports:1}:null)};}} as any);
 expect(calls).toBe(2);expect(result.checked).toBe(101);expect(result.ignored).toHaveLength(100);expect(s.listWallets().map(w=>w.name)).toEqual(['w0']);
});
test('RPC failure or truncated response never classifies an unavailable balance as zero',async()=>{
 const s=core();wallet(s,'keep');
 await expect(ignoreZeroSolWallets(s.wallets,{getMultipleAccountsInfoAndContext:async()=>{throw Error('provider unavailable');}} as any)).rejects.toThrow('provider unavailable');
 await expect(ignoreZeroSolWallets(s.wallets,{getMultipleAccountsInfoAndContext:async()=>({context:{slot:1},value:[]})} as any)).rejects.toThrow('Truncated');
 expect(s.listWallets()).toHaveLength(1);
});
test('failure after a successful zero-balance batch leaves every wallet active',async()=>{
 const s=core();for(let i=0;i<101;i++)wallet(s,`w${i}`);let calls=0;
 await expect(ignoreZeroSolWallets(s.wallets,{getMultipleAccountsInfoAndContext:async(addresses:any[])=>{if(++calls===2)throw Error('later batch failed');return {context:{slot:3},value:addresses.map(()=>null)};}} as any)).rejects.toThrow('later batch failed');
 expect(s.listWallets()).toHaveLength(101);
});
