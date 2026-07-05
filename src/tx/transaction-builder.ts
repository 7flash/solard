import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import type { WalletRef } from "../core/refs.js";
import type { PlannedTransaction, SendReceipt, SenderId, SendOptions, SimulationResult, TransactionAction, TransactionDraft, TrackedAccount } from "./types.js";

export interface TransactionHost {
  signer(ref: WalletRef): Keypair;
  compile(payer: Keypair, draft: TransactionDraft): Promise<PlannedTransaction>;
  simulatePlan(plan: PlannedTransaction): Promise<SimulationResult>;
  sendPlan(plan: PlannedTransaction, via: SenderId, kind?: string, options?: SendOptions): Promise<SendReceipt>;
}
export class SowlTransaction {
  protected readonly draft: TransactionDraft = { instructions: [], signers: [], actions: [], trackedAccounts: [] };
  add(ix: TransactionInstruction, action?: TransactionAction): this { this.draft.instructions.push(ix); if (action) this.draft.actions.push(action); return this; }
  addMany(ixs: TransactionInstruction[], action?: TransactionAction): this { this.draft.instructions.push(...ixs); if (action) this.draft.actions.push(action); return this; }
  priorityFee(value: { cuLimit?: number; microLamports?: number }): this {
    if (value.cuLimit != null) this.draft.cuLimit = value.cuLimit;
    if (value.microLamports != null) this.draft.cuPriceMicroLamports = value.microLamports;
    return this;
  }
  withSigner(keypair: Keypair): this { this.draft.signers.push(keypair); return this; }
  track(account: TrackedAccount): this { this.draft.trackedAccounts.push(account); return this; }
  snapshot(): TransactionDraft { return { ...this.draft, instructions: [...this.draft.instructions], signers: [...this.draft.signers], actions: [...this.draft.actions], trackedAccounts: [...this.draft.trackedAccounts] }; }
}
export class TransactionBuilder extends SowlTransaction {
  constructor(protected readonly host: TransactionHost, protected readonly payerRef: WalletRef) { super(); }
  async build(): Promise<PlannedTransaction> { return await this.host.compile(this.host.signer(this.payerRef), this.snapshot()); }
  async simulate(): Promise<SimulationResult> { return await this.host.simulatePlan(await this.build()); }
  async send(options: { via?: SenderId; kind?: string; skipSimulation?: boolean; skipPreflight?: boolean } = {}): Promise<SendReceipt> {
    return await this.host.sendPlan(await this.build(), options.via ?? "rpc", options.kind, options);
  }
  payer(): PublicKey { return this.host.signer(this.payerRef).publicKey; }
}
