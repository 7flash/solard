import type {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";

export type SenderId = "rpc" | "helius" | "jito" | string;
export type SendOptions = { skipSimulation?: boolean; skipPreflight?: boolean };
export type TransactionAction = {
  kind:
    | "claim"
    | "buy"
    | "sell"
    | "transfer-sol"
    | "transfer-token"
    | "unwrap-wsol"
    | "create-ata"
    | string;
  mint?: PublicKey;
  recipient?: PublicKey;
  meta?: Record<string, unknown>;
};
export type TrackedAccount = {
  address: PublicKey;
  kind: "sol" | "token";
  mint?: PublicKey;
};
export type TransactionDraft = {
  instructions: TransactionInstruction[];
  signers: Keypair[];
  actions: TransactionAction[];
  trackedAccounts: TrackedAccount[];
  cuLimit?: number;
  cuPriceMicroLamports?: number;
};
export type PlannedTransaction = {
  transaction: VersionedTransaction;
  draft: TransactionDraft;
  lookupTables: AddressLookupTableAccount[];
  serializedSize: number;
  payer: PublicKey;
};
export type SimulationResult = {
  success: boolean;
  logs: string[];
  cuUsed: number | null;
  error: unknown | null;
  accountChanges: Array<{
    address: string;
    beforeLamports: number | null;
    afterLamports: number | null;
    deltaLamports: number | null;
  }>;
  tokenChanges: Array<{
    address: string;
    mint: string | null;
    beforeRaw: string | null;
    afterRaw: string | null;
    deltaRaw: string | null;
  }>;
  solChanges: Array<{
    address: string;
    beforeLamports: number | null;
    afterLamports: number | null;
    deltaLamports: number | null;
  }>;
};
export type SendReceipt = {
  signature: string;
  slot: number | null;
  sender: string;
  status: "broadcast" | "confirmed" | "failed";
  error?: string;
};
export type SubmittedPlan = {
  signature: string;
  sender: string;
  executionId: number;
  plan: PlannedTransaction;
};
export type BatchSendReceipt = {
  sender: string;
  mode: "parallel" | "bundle";
  submissionId?: string;
  receipts: SendReceipt[];
};
