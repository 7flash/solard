import {test,expect} from 'bun:test';
import {Keypair,PublicKey,SystemProgram,type Connection} from '@solana/web3.js';
import {composeTransactionDrafts} from './compose-drafts.ts';
import type {TransactionDraft} from './types.ts';
import {Solard} from '../core/solard.ts';
import {TransactionComposer} from './composer.ts';
import {SOL_ASSET,sol} from '../core/amounts.ts';
const a=Keypair.generate(),b=Keypair.generate(),dest=Keypair.generate().publicKey;
const draft=(payer=a,tag='a'):TransactionDraft=>({instructions:[SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:dest,lamports:1})],actions:[{kind:'transfer',meta:{tag}}],signers:[],trackedAccounts:[{address:payer.publicKey,kind:'sol'}],cuLimit:100_000,cuPriceMicroLamports:20_000});
function host(){let hashes=0;const core=Object.create(Solard.prototype) as Solard;
 core.signer=((ref:string)=>ref==='a'?a:b) as any;core.connection=()=>({}) as Connection;
 Object.defineProperty(core,'blockhash',{value:{get:async()=>{hashes++;return {blockhash:PublicKey.default.toBase58(),lastValidBlockHeight:100};}}});
 Object.defineProperty(core,'alts',{value:{list:()=>[]}});Object.defineProperty(core,'transactionVersion',{value:1});return {core,hashes:()=>hashes};}

test('composition preserves instruction/action order, signers, tracking and explicit compute budgets',()=>{
 const first=draft(),second=draft(a,'b');first.signers=[b];second.signers=[b];
 const merged=composeTransactionDrafts([first,second]);
 expect(merged.instructions).toEqual([...first.instructions,...second.instructions]);expect(merged.actions.map(x=>x.meta?.tag)).toEqual(['a','b']);
 expect(merged.signers).toEqual([b]);expect(merged.trackedAccounts).toHaveLength(1);expect(merged.cuLimit).toBe(200_000);
 merged.actions[0]!.meta!.tag='changed';expect(first.actions[0]!.meta?.tag).toBe('a');
 expect(()=>composeTransactionDrafts([{...first,cuLimit:1_000_000},second],{cuLimit:1_400_001})).toThrow();
 expect(()=>composeTransactionDrafts([])).toThrow();
});
test('multi-wallet groups are fully signed with exactly one blockhash read',async()=>{
 const {core,hashes}=host();const plans=await core.compileGroups([{payer:'a',drafts:[draft(),draft(b,'b')],additionalWallets:['b']},{payer:'b',drafts:[draft(b,'second')]}]);
 expect(hashes()).toBe(1);expect(new Set(plans.map(p=>p.recentBlockhash)).size).toBe(1);
 expect(plans[0]!.transaction.signatures).toHaveLength(2);expect(plans.every(p=>p.transaction.signatures.every(s=>s.some(byte=>byte!==0)))).toBe(true);
 expect(plans[0]!.draft.actions.map(a=>a.meta?.tag)).toEqual(['a','b']);
});
test('missing group co-signer fails before blockhash lookup or signing',async()=>{
 const {core,hashes}=host();await expect(core.compileGroups([{payer:'a',drafts:[draft(b)]}])).rejects.toThrow('Missing group signer');expect(hashes()).toBe(0);
});
test('claim then transfer uses the existing composer in one ordered transaction draft',async()=>{
 const claim=SystemProgram.transfer({fromPubkey:b.publicKey,toPubkey:a.publicKey,lamports:5});
 const core={signer:()=>a,resolveTokenForExecution:async()=>({mint:dest.toBase58()}),resolveClaim:async()=>({instructions:[claim],source:'fixture',quoteAsset:SOL_ASSET,estimatedClaimRaw:5n,spendableByUserRaw:5n})};
 const result=await new TransactionComposer(core as any,'a').claimFees(dest.toBase58()).transferSol(dest,sol('0.000000005')).materializedDraft();
 expect(result.instructions[0]).toBe(claim);expect(result.instructions).toHaveLength(2);expect(result.actions[0]!.kind).toBe('claim');
 expect(result.instructions[1]!.keys[0]!.pubkey.equals(a.publicKey)).toBe(true);
});
test('raw instruction composition stays ordered after async claims and materializes only once',async()=>{
 const claim=draft().instructions[0]!,raw=draft(b).instructions[0]!;let claims=0;
 const core={signer:()=>a,resolveTokenForExecution:async()=>({mint:dest.toBase58()}),resolveClaim:async()=>{claims++;await Bun.sleep(1);return {instructions:[claim],source:'fixture',quoteAsset:SOL_ASSET,estimatedClaimRaw:5n,spendableByUserRaw:5n};}};
 const tx=new TransactionComposer(core as any,'a').claimFees(dest.toBase58()).addMany([raw]);
 const pending=tx.materializedDraft();expect(()=>tx.add(raw)).toThrow('Cannot change a built transaction');
 const [first,second]=await Promise.all([pending,tx.materializedDraft()]);
 expect(first.instructions).toEqual([claim,raw]);expect(second.instructions).toEqual([claim,raw]);expect(claims).toBe(1);
 expect(()=>tx.add(raw)).toThrow('Cannot change a built transaction');
});
