import { Buffer } from "buffer";
import bs58 from "bs58";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";

import type { BrowserSwapBuild } from "./types.ts";

export type JupiterInstruction = {
  programId: string;
  accounts: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  data: string;
};

export type JupiterBuildResponse = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  routePlan: unknown[];
  computeBudgetInstructions: JupiterInstruction[];
  setupInstructions: JupiterInstruction[];
  swapInstruction: JupiterInstruction;
  cleanupInstruction: JupiterInstruction | null;
  otherInstructions: JupiterInstruction[];
  tipInstruction: JupiterInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
  blockhashWithMetadata: {
    blockhash: number[];
    lastValidBlockHeight: number;
    fetchedAt?: string;
  };
  error?: string;
};

export type JupiterBuildOptions = {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint | string;
  taker: string;
  slippageBps?: number | "rtse";
  mode?: "fast";
  wrapAndUnwrapSol?: boolean;
  maxAccounts?: number;
};

export type JupiterBrowserConfig = {
  baseUrl?: string;
  apiKey?: string;
  fetch: typeof globalThis.fetch;
};

function toInstruction(ix: JupiterInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

function addressLookupTableFromMappedAddresses(
  address: string,
  mapped: string[],
): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: new PublicKey(address),
    state: {
      deactivationSlot: 0xffff_ffff_ffff_ffffn,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: mapped.map((value) => new PublicKey(value)),
    },
  });
}

async function lookupTables(
  connection: Connection,
  build: JupiterBuildResponse,
): Promise<AddressLookupTableAccount[]> {
  const mapped = build.addressesByLookupTableAddress;
  if (!mapped) return [];

  const out: AddressLookupTableAccount[] = [];
  for (const [address, addresses] of Object.entries(mapped)) {
    if (addresses.length > 0) {
      out.push(addressLookupTableFromMappedAddresses(address, addresses));
      continue;
    }

    // Defensive fallback for an API response that only names an ALT.
    const fetched = await connection.getAddressLookupTable(
      new PublicKey(address),
      { commitment: "confirmed" },
    );
    if (fetched.value) out.push(fetched.value);
  }
  return out;
}

function query(options: JupiterBuildOptions): URLSearchParams {
  const params = new URLSearchParams({
    inputMint: new PublicKey(options.inputMint).toBase58(),
    outputMint: new PublicKey(options.outputMint).toBase58(),
    amount:
      typeof options.amountRaw === "bigint"
        ? options.amountRaw.toString()
        : options.amountRaw,
    taker: new PublicKey(options.taker).toBase58(),
  });

  if (options.slippageBps != null) {
    params.set("slippageBps", String(options.slippageBps));
  }
  if (options.mode) params.set("mode", options.mode);
  if (options.wrapAndUnwrapSol != null) {
    params.set("wrapAndUnwrapSol", String(options.wrapAndUnwrapSol));
  }
  if (options.maxAccounts != null) {
    params.set("maxAccounts", String(options.maxAccounts));
  }
  return params;
}

export async function fetchJupiterBuild(
  config: JupiterBrowserConfig,
  options: JupiterBuildOptions,
): Promise<JupiterBuildResponse> {
  const baseUrl = (config.baseUrl ?? "https://api.jup.ag/swap/v2").replace(
    /\/+$/,
    "",
  );
  const headers = new Headers();
  if (config.apiKey) headers.set("x-api-key", config.apiKey);

  const response = await config.fetch(
    `${baseUrl}/build?${query(options).toString()}`,
    { headers },
  );
  const text = await response.text();
  let parsed: JupiterBuildResponse;
  try {
    parsed = JSON.parse(text) as JupiterBuildResponse;
  } catch {
    throw new Error(
      `Jupiter /build returned HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }

  if (!response.ok || parsed.error) {
    throw new Error(
      parsed.error ??
        `Jupiter /build returned HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  if (!parsed.swapInstruction || !parsed.blockhashWithMetadata) {
    throw new Error("Jupiter /build response is missing transaction fields.");
  }
  return parsed;
}

/**
 * Build a Jupiter Router swap as a normal v0 transaction.
 *
 * It is intentionally not signed or submitted here. The browser wallet signs
 * the returned transaction and BrowserSolard sends the bytes to the configured
 * Solana RPC directly.
 */
export async function buildJupiterDirectSwap(args: {
  connection: Connection;
  config: JupiterBrowserConfig;
  options: JupiterBuildOptions;
  simulate?: boolean;
}): Promise<BrowserSwapBuild> {
  const build = await fetchJupiterBuild(args.config, args.options);
  const alts = await lookupTables(args.connection, build);
  const recentBlockhash = bs58.encode(
    Uint8Array.from(build.blockhashWithMetadata.blockhash),
  );

  const bodyInstructions = [
    ...build.setupInstructions.map(toInstruction),
    toInstruction(build.swapInstruction),
    ...(build.cleanupInstruction
      ? [toInstruction(build.cleanupInstruction)]
      : []),
    ...build.otherInstructions.map(toInstruction),
    ...(build.tipInstruction ? [toInstruction(build.tipInstruction)] : []),
  ];

  const payerKey = new PublicKey(args.options.taker);
  const maxUnits = 1_400_000;
  let units = maxUnits;

  if (args.simulate !== false) {
    const simulationMessage = new TransactionMessage({
      payerKey,
      recentBlockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: maxUnits }),
        ...build.computeBudgetInstructions.map(toInstruction),
        ...bodyInstructions,
      ],
    }).compileToV0Message(alts);

    const simulation = await args.connection.simulateTransaction(
      new VersionedTransaction(simulationMessage),
      {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "processed",
      },
    );
    if (simulation.value.err) {
      throw new Error(
        `Jupiter swap simulation failed: ${JSON.stringify(simulation.value.err)}`,
      );
    }
    if (simulation.value.unitsConsumed) {
      units = Math.min(
        maxUnits,
        Math.max(50_000, Math.ceil(simulation.value.unitsConsumed * 1.2)),
      );
    }
  }

  const finalMessage = new TransactionMessage({
    payerKey,
    recentBlockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ...build.computeBudgetInstructions.map(toInstruction),
      ...bodyInstructions,
    ],
  }).compileToV0Message(alts);

  return {
    transaction: new VersionedTransaction(finalMessage),
    inputMint: build.inputMint,
    outputMint: build.outputMint,
    inAmount: build.inAmount,
    outAmount: build.outAmount,
    otherAmountThreshold: build.otherAmountThreshold,
    routePlan: build.routePlan,
    blockhash: recentBlockhash,
    lastValidBlockHeight: build.blockhashWithMetadata.lastValidBlockHeight,
    unitsConsumed: units,
  };
}
