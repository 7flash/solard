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
  recentBlockhash: string;
  lastValidBlockHeight: number;
};
export type SimulationResult = {
  success: boolean;
  logs: string[];
  cuUsed: number | null;
  error: unknown | null;
  /** Best-effort fee-payer account check after AccountNotFound, separate from program logs. */
  diagnostics?: {
    message: string;
    feePayer: { address: string; exists: boolean | null; lamports: number | null };
  };
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
  /** Selected/estimated fees remain separate from confirmed feeLamports. */
  feeEstimate?: import("./fee-estimate.ts").TransactionFeeEstimate;
  /** Confirmed wallet SOL principal, excluding network fees and token-account rent. */
  solPrincipalDeltaLamports?: bigint;
  targetTokenDeltaRaw?: bigint;
  networkFeeLamports?: bigint;
  /** Only verified expiry with successful absence checks permits a replacement. */
  retryable?: boolean;
  signature: string;
  slot: number | null;
  sender: string;
  status: "submitted" | "confirmed" | "failed";
  /** Actual fee charged by the cluster, populated after transaction metadata is available. */
  feeLamports?: number;
  /** Actual compute units consumed, populated when returned by transaction metadata. */
  computeUnitsConsumed?: number;
  error?: string;
};
export type SubmittedPlan = {
  feeEstimate?: import("./fee-estimate.ts").TransactionFeeEstimate;
  onRebroadcast?: (signature: string) => void;
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
