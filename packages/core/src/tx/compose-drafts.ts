import type {TransactionDraft} from './types.ts';
import type {WalletRef} from '../core/refs.ts';

export type TransactionGroupInput={
 payer:WalletRef;
 drafts:readonly TransactionDraft[];
 additionalWallets?:readonly WalletRef[];
 cuLimit?:number;
 priorityMicroLamports?:number;
};

/** Ordered atomic instruction composition. Never quotes, signs, sends, splits,
 * discards actions, or assumes a previous transaction has landed.
 */
export function composeTransactionDrafts(drafts:readonly TransactionDraft[],options:{cuLimit?:number;priorityMicroLamports?:number}={}):TransactionDraft{
 if(!drafts.length||!drafts.some(d=>d.instructions.length))throw Error('Cannot compose an empty transaction');
 const cuLimit=options.cuLimit??drafts.reduce((n,d)=>n+(d.instructions.length?(d.cuLimit??600_000):0),0);
 const price=options.priorityMicroLamports??Math.max(0,...drafts.map(d=>d.cuPriceMicroLamports??100_000));
 if(!Number.isSafeInteger(cuLimit)||cuLimit<1||cuLimit>1_400_000)throw Error('Composed compute limit must be 1..1400000; set an explicit group limit');
 if(!Number.isSafeInteger(price)||price<0)throw Error('Invalid composed priority fee');
 const signers=new Map(drafts.flatMap(d=>d.signers).map(s=>[s.publicKey.toBase58(),s]));
 const tracked=new Map(drafts.flatMap(d=>d.trackedAccounts).map(a=>[`${a.kind}:${a.address.toBase58()}:${a.mint?.toBase58()??''}`,a]));
 return {instructions:drafts.flatMap(d=>d.instructions),actions:drafts.flatMap(d=>d.actions.map(a=>({...a,meta:a.meta?{...a.meta}:undefined}))),signers:[...signers.values()],trackedAccounts:[...tracked.values()],cuLimit,cuPriceMicroLamports:price};
}
