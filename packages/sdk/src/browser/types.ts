import type { PumpExternalDeploymentBuild } from "@solard/core";
import type {
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

export interface BrowserWalletSigner {
  publicKey: PublicKey | null;
  connect?: () => Promise<unknown>;
  disconnect?: () => Promise<unknown>;
  signTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
  ): Promise<T>;
  signAllTransactions?<T extends Transaction | VersionedTransaction>(
    transactions: T[],
  ): Promise<T[]>;
}

export interface BrowserStorageLike {
  readonly length: number;
  clear(): void;
  getItem(key: string): string | null;
  key(index: number): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export type BrowserContact = {
  name: string;
  address: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type BrowserTokenAlias = {
  alias: string;
  mint: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type BrowserTokenBalance = {
  mint: string;
  amountRaw: bigint;
  amountUi: string;
  decimals: number;
  program: "spl-token" | "token-2022";
  label: string;
  tokenAccounts: string[];
};

export type BrowserPortfolio = {
  address: string;
  solLamports: bigint;
  tokenBalances: BrowserTokenBalance[];
};

export type BrowserTransactionSubmission = {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
};

export type BrowserConfirmedTransaction = BrowserTransactionSubmission & {
  status: "confirmed";
};

export type BrowserTradeSide = "buy" | "sell";

export type BrowserTradeBuild = {
  transaction: VersionedTransaction;
  side: BrowserTradeSide;
  venue: string;
  mint: string;
  inputRaw: bigint;
  expectedOutputRaw: bigint;
  minimumOutputRaw: bigint;
  quoteMint: string;
  quoteDecimals: number;
  blockhash: string;
  lastValidBlockHeight: number;
  serializedSize: number;
};

export type BrowserTradeResult = BrowserConfirmedTransaction & {
  side: BrowserTradeSide;
  venue: string;
  mint: string;
  inputRaw: bigint;
  expectedOutputRaw: bigint;
  minimumOutputRaw: bigint;
};

export type BrowserSolardOptions = {
  rpcUrl: string;
  wallet?: BrowserWalletSigner | null;
  storage?: BrowserStorageLike;
  storageNamespace?: string;
  commitment?: "processed" | "confirmed" | "finalized";
  rpcMaxRps?: number;
  fetch?: typeof globalThis.fetch;
};
export type BrowserPumpDeploymentBuild = PumpExternalDeploymentBuild;

export type BrowserPumpDeploymentResult = BrowserConfirmedTransaction & {
  mint: string;
  beneficiary: string;
  quoteMint: string;
  quoteKind: "native-sol" | "spl-token";
};
