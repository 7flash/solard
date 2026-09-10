import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";

import { readMint } from "../../chain/state.ts";
import { SOL_ASSET, type QuoteAsset } from "../../core/amounts.ts";
import type { TokenRow } from "../../db/schema.ts";
import { PumpTokenLaunchpad } from "../../venues/pump/pump-launchpad.ts";

const SOLANA_PACKET_LIMIT = 1232;

/** Canonical USDC mint documented by Pump for create_v2 quote-mint launches. */
export const PUMP_USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);

export type PumpCustomPairSelection = {
  /** Current Solana quote mint selected from Pump's Custom Pairs catalog. */
  mint: string | PublicKey;
  /** Optional UI metadata; never trusted for routing. */
  symbol?: string;
  name?: string;
};

export type PumpLaunchPairInput =
  string | PublicKey | QuoteAsset | PumpCustomPairSelection | undefined;

export type PumpExternalDeploymentBuild = {
  version: 1;
  launchpad: "pump";
  transaction: VersionedTransaction;
  /** Partially signed: generated mint signature is present; payer signature is absent. */
  transactionBase64: string;
  payer: string;
  mint: string;
  beneficiary: string;
  quoteMint: string;
  quoteKind: QuoteAsset["kind"];
  quoteDecimals: number;
  quoteTokenProgram: string;
  requiredSignerPubkeys: string[];
  partialSignerPubkeys: string[];
  missingSignerPubkeys: string[];
  blockhash: string;
  lastValidBlockHeight: number;
  serializedSize: number;
  token: Partial<TokenRow> & { mint: string };
};

function looksLikeCrossChainAddress(value: string): boolean {
  return /^0x[0-9a-f]{40}$/i.test(value.trim());
}

function bytesToBase64(bytes: Uint8Array): string {
  const BufferCtor = (globalThis as any).Buffer as
    | { from(value: Uint8Array): { toString(encoding: "base64"): string } }
    | undefined;
  if (BufferCtor) return BufferCtor.from(bytes).toString("base64");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  if (typeof btoa !== "function") {
    throw new Error("No base64 encoder is available in this runtime.");
  }
  return btoa(binary);
}

function signaturePresent(signature: Uint8Array | undefined): boolean {
  return Boolean(signature?.some((byte) => byte !== 0));
}

/**
 * Resolve the quote side of a Solana Pump create_v2 / Custom Pair launch.
 *
 * SOL and USDC have friendly aliases. Every other pair is accepted by its
 * Solana quote-mint address and its decimals/token program are read directly
 * from chain. Pump's create_v2 program remains the authority on whether that
 * quote mint is currently enabled by Pump's supported-pair configuration.
 *
 * This deliberately does not hard-code a stale ticker -> mint table. Pump's
 * Custom Pair catalog can change independently of the SDK; frontends should
 * pass the selected asset's current Solana quote mint.
 */
export async function resolvePumpQuoteAsset(
  connection: Connection,
  pair: PumpLaunchPairInput = "SOL",
): Promise<QuoteAsset> {
  if (pair && typeof pair === "object" && "kind" in pair) return pair;

  const pairValue =
    pair &&
    typeof pair === "object" &&
    !(pair instanceof PublicKey) &&
    "mint" in pair
      ? pair.mint
      : pair;
  const raw =
    pairValue instanceof PublicKey
      ? pairValue.toBase58()
      : String(pairValue ?? "SOL").trim();
  const upper = raw.toUpperCase();

  if (
    !raw ||
    upper === "SOL" ||
    upper === "WSOL" ||
    raw === NATIVE_MINT.toBase58()
  ) {
    return SOL_ASSET;
  }

  if (upper === "USDC" || raw === PUMP_USDC_MINT.toBase58()) {
    return {
      kind: "spl-token",
      mint: PUMP_USDC_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      decimals: 6,
    };
  }

  if (looksLikeCrossChainAddress(raw)) {
    throw new Error(
      `Pump Custom Pair ${raw} is not a Solana public key. ` +
        "Pass the selected pair asset's Solana quote mint.",
    );
  }

  let mint: PublicKey;
  try {
    mint = new PublicKey(raw);
  } catch {
    throw new Error(
      `Pump Custom Pair \"${raw}\" needs its Solana quote-mint address. ` +
        "Use SOL/USDC directly, or pass the mint selected by the Pump Custom Pairs catalog (for example the mint behind TSLAX/NVDAX/etc.).",
    );
  }

  const info = await readMint(connection, mint);
  return {
    kind: "spl-token",
    mint,
    tokenProgram: info.tokenProgram,
    decimals: info.decimals,
  };
}

/**
 * Build a Pump create_v2 transaction for an external wallet such as Phantom.
 * The generated mint keypair signs locally; the payer/user signature is left
 * intentionally blank. Nothing is broadcast and no persisted Solard wallet is
 * required.
 */
export async function buildPumpExternalDeployment(args: {
  connection: Connection;
  payer: string | PublicKey;
  name: string;
  symbol: string;
  uri: string;
  pair?: PumpLaunchPairInput;
  beneficiary?: string | PublicKey;
  mint?: Keypair;
  mayhemMode?: boolean;
  cashback?: boolean;
  cuLimit?: number;
  priorityMicroLamports?: number;
}): Promise<PumpExternalDeploymentBuild> {
  const payer =
    args.payer instanceof PublicKey ? args.payer : new PublicKey(args.payer);
  const beneficiary =
    args.beneficiary == null
      ? payer
      : args.beneficiary instanceof PublicKey
        ? args.beneficiary
        : new PublicKey(args.beneficiary);
  const quoteAsset = await resolvePumpQuoteAsset(args.connection, args.pair);

  const launchpad = new PumpTokenLaunchpad();
  const deployment = await launchpad.prepareDeployment(args.connection, {
    name: args.name,
    symbol: args.symbol,
    uri: args.uri,
    user: payer,
    creator: beneficiary,
    mint: args.mint,
    quoteAsset,
    mayhemMode: args.mayhemMode,
    cashback: args.cashback,
  });

  const latest = await args.connection.getLatestBlockhash("confirmed");
  const compute = [
    ComputeBudgetProgram.setComputeUnitLimit({
      units: Math.max(1, Math.trunc(args.cuLimit ?? 600_000)),
    }),
  ];
  const priority = Math.max(0, Math.trunc(args.priorityMicroLamports ?? 0));
  if (priority > 0) {
    compute.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
    );
  }

  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: latest.blockhash,
    instructions: [...compute, ...deployment.instructions],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);

  // Sign only keys Solard actually owns for this external-wallet build. For
  // Pump create_v2 this is the generated mint. Phantom remains the missing payer.
  transaction.sign(deployment.signers);

  const requiredSignerPubkeys = message.staticAccountKeys
    .slice(0, message.header.numRequiredSignatures)
    .map((key) => key.toBase58());
  const partialSignerPubkeys = requiredSignerPubkeys.filter((_, index) =>
    signaturePresent(transaction.signatures[index]),
  );
  const missingSignerPubkeys = requiredSignerPubkeys.filter(
    (_, index) => !signaturePresent(transaction.signatures[index]),
  );

  const serialized = transaction.serialize();
  if (serialized.length > SOLANA_PACKET_LIMIT) {
    throw new Error(
      `Pump deployment transaction is ${serialized.length} bytes; Solana packet limit is ${SOLANA_PACKET_LIMIT}.`,
    );
  }
  if (!partialSignerPubkeys.includes(deployment.mint.publicKey.toBase58())) {
    throw new Error(
      "Pump external deployment did not retain the generated mint signature.",
    );
  }
  if (!missingSignerPubkeys.includes(payer.toBase58())) {
    throw new Error(
      "Pump external deployment unexpectedly contains the payer signature; external-wallet builds must not sign for the user.",
    );
  }

  return {
    version: 1,
    launchpad: "pump",
    transaction,
    transactionBase64: bytesToBase64(serialized),
    payer: payer.toBase58(),
    mint: deployment.mint.publicKey.toBase58(),
    beneficiary: beneficiary.toBase58(),
    quoteMint: quoteAsset.mint.toBase58(),
    quoteKind: quoteAsset.kind,
    quoteDecimals: quoteAsset.decimals,
    quoteTokenProgram: quoteAsset.tokenProgram.toBase58(),
    requiredSignerPubkeys,
    partialSignerPubkeys,
    missingSignerPubkeys,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    serializedSize: serialized.length,
    token: deployment.token,
  };
}
