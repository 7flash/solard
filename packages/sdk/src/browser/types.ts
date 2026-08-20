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

export type BrowserBroadcastResult = {
  signature: string;
  confirmed: boolean;
  blockhash: string;
  lastValidBlockHeight: number;
};

export type BrowserSwapBuild = {
  transaction: VersionedTransaction;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  routePlan: unknown[];
  blockhash: string;
  lastValidBlockHeight: number;
  unitsConsumed?: number;
};

export type BrowserSwapResult = BrowserBroadcastResult & {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  quotedOutAmount: string;
};

export type BrowserSolardOptions = {
  rpcUrl: string;
  wallet?: BrowserWalletSigner | null;
  storage?: BrowserStorageLike;
  storageNamespace?: string;
  commitment?: "processed" | "confirmed" | "finalized";
  rpcMaxRps?: number;
  jupiterApiKey?: string;
  jupiterBaseUrl?: string;
  jupiterMaxRps?: number;
  fetch?: typeof globalThis.fetch;
};
