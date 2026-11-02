import { PublicKey, VersionedTransaction, MessageAccountKeys, ComputeBudgetProgram, type Keypair } from "@solana/web3.js";
import { VersionedTransaction as NativeTransaction, TransactionMessage, TransactionInstruction, PublicKey as NativeKey, Keypair as NativeSigner, type MessageV1, type Blockhash, type V1TransactionConfig } from "@solana/web3-v1";
import type { TransactionDraft } from "./types.ts";

/** Retains native v1 bytes/signatures while exposing existing web3 1.x public keys. */
export class V1Transaction {
  readonly version = 1 as const;
  readonly message;
  constructor(private readonly native: NativeTransaction, private readonly lastValidBlockHeight?: number) {
    if (native.version !== 1) throw Error("Expected native v1 transaction");
    const message = native.message as MessageV1;
    this.message = {
      version: 1 as const,
      header: message.header,
      staticAccountKeys: message.staticAccountKeys.map(key => new PublicKey(key.toBase58())),
      recentBlockhash: message.recentBlockhash as string,
      compiledInstructions: message.compiledInstructions,
      transactionConfig: {
        computeUnitLimit: message.transactionConfig?.computeUnitLimit ?? null,
        heapSize: message.transactionConfig?.heapSize ?? null,
        loadedAccountsDataSizeLimit: message.transactionConfig?.loadedAccountsDataSizeLimit ?? null,
        priorityFee: message.transactionConfig?.priorityFeeLamports == null ? null : Number(message.transactionConfig.priorityFeeLamports),
      },
      addressTableLookups: [],
      getAccountKeys: () => new MessageAccountKeys(message.staticAccountKeys.map(key => new PublicKey(key.toBase58()))),
      isAccountSigner: (index: number) => message.isAccountSigner(index),
      isAccountWritable: (index: number) => message.isAccountWritable(index),
      serialize: () => message.serialize(),
    };
  }
  get signatures() { return this.native.signatures; }
  serialize(): Uint8Array { return this.native.serialize(); }
  addSignature(publicKey: PublicKey, signature: Uint8Array): void {
    this.native.addSignature(new NativeKey(publicKey.toBase58()), signature);
  }
  async sign(signers: Keypair[], lastValidBlockHeight = this.lastValidBlockHeight): Promise<void> {
    if (lastValidBlockHeight == null) throw Error("V1 signing requires the actual lastValidBlockHeight");
    await this.native.sign(await Promise.all(signers.map(signer => NativeSigner.fromSecretKey(signer.secretKey))), {lastValidBlockHeight:BigInt(lastValidBlockHeight)});
  }
}
export type WireTransaction = VersionedTransaction | V1Transaction;
export function deserializeWireTransaction(bytes: Uint8Array): WireTransaction {
  if (bytes[0] === 0x81) return new V1Transaction(NativeTransaction.deserialize(bytes));
  return VersionedTransaction.deserialize(bytes);
}
export async function buildV1Transaction(payer: PublicKey, draft: TransactionDraft, blockhash: string, lastValidBlockHeight: number): Promise<V1Transaction> {
  if (draft.instructions.some(ix => ix.programId.equals(ComputeBudgetProgram.programId)))
    throw Error("V1 resource limits must use transaction config, not ComputeBudget instructions");
  const instructions = draft.instructions.map(ix => new TransactionInstruction({
    programId:new NativeKey(ix.programId.toBase58()), data:ix.data,
    keys:ix.keys.map(key => ({...key,pubkey:new NativeKey(key.pubkey.toBase58())})),
  }));
  const cu = draft.cuLimit ?? 600000;
  const price = draft.cuPriceMicroLamports ?? 100000;
  if (!Number.isSafeInteger(cu) || cu < 1 || cu > 1400000 || !Number.isSafeInteger(price) || price < 0)
    throw Error("Invalid v1 compute budget");
  const priorityFee=(BigInt(cu)*BigInt(price)+999999n)/1000000n;
  if(priorityFee>BigInt(Number.MAX_SAFE_INTEGER))throw Error("V1 priority fee exceeds safe accounting range");
  if (instructions.length > 64) throw Error("V1 transaction exceeds 64 instruction limit");
  new PublicKey(blockhash); // Validate the lifetime hash before applying the branded SDK type.
  const message = new TransactionMessage({payerKey:new NativeKey(payer.toBase58()),recentBlockhash:blockhash as Blockhash,instructions}).compileToV1Message({
    computeUnitLimit:cu, loadedAccountsDataSizeLimit:64*1024*1024,
    priorityFeeLamports:priorityFee as NonNullable<V1TransactionConfig["priorityFeeLamports"]>,
  });
  if (message.staticAccountKeys.length > 64) throw Error("V1 transaction exceeds 64 account limit");
  return new V1Transaction(new NativeTransaction(message), lastValidBlockHeight);
}
