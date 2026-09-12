import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";

import { readMint } from "@solard/core";
import { rawAmount } from "@solard/core";
import type { TokenRow } from "@solard/core";
import { PumpCurveVenue } from "@solard/core";
import { PumpSwapVenue } from "@solard/core";
import { VenueRegistry } from "@solard/core";

import type { BrowserTradeBuild } from "./types.ts";

const PACKET_LIMIT = 1232;

function tokenShell(args: {
  mint: string;
  decimals: number;
  baseTokenProgram: string;
}): TokenRow {
  const now = Date.now();
  return {
    id: 0,
    mint: args.mint,
    name: null,
    symbol: null,
    decimals: args.decimals,
    createKind: "unknown",
    creator: null,
    quoteMint: null,
    quoteTokenProgram: null,
    baseTokenProgram: args.baseTokenProgram,
    bondingCurve: null,
    pool: null,
    sharingConfig: null,
    venueHint: "unknown",
    metadataJson: null,
    refreshedAtMs: null,
    createdAtMs: now,
    updatedAtMs: now,
  } as TokenRow;
}

async function resolvePumpToken(
  connection: Connection,
  mint: PublicKey,
): Promise<{ registry: VenueRegistry; token: TokenRow }> {
  const mintInfo = await readMint(connection, mint);
  const registry = new VenueRegistry()
    .register(new PumpCurveVenue())
    .register(new PumpSwapVenue());
  const shell = tokenShell({
    mint: mint.toBase58(),
    decimals: mintInfo.decimals,
    baseTokenProgram: mintInfo.tokenProgram.toBase58(),
  });
  const inspected = await registry.inspect(connection, mint);
  if (!inspected) {
    throw new Error(
      `Mint ${mint.toBase58()} is not a supported Pump/PumpSwap token.`,
    );
  }
  return { registry, token: { ...shell, ...inspected } as TokenRow };
}

function priorityInstructions(options: {
  cuLimit?: number;
  priorityMicroLamports?: number;
}) {
  const out = [];
  if (options.cuLimit != null) {
    out.push(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: Math.max(1, Math.trunc(options.cuLimit)),
      }),
    );
  }
  if (options.priorityMicroLamports != null) {
    out.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: Math.max(0, Math.trunc(options.priorityMicroLamports)),
      }),
    );
  }
  return out;
}

async function compile(args: {
  connection: Connection;
  user: PublicKey;
  instructions: TransactionInstruction[];
  side: "buy" | "sell";
  venue: string;
  mint: PublicKey;
  inputRaw: bigint;
  expectedOutputRaw: bigint;
  minimumOutputRaw: bigint;
  quoteMint: PublicKey;
  quoteDecimals: number;
  cuLimit?: number;
  priorityMicroLamports?: number;
}): Promise<BrowserTradeBuild> {
  const latest = await args.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: args.user,
    recentBlockhash: latest.blockhash,
    instructions: [...priorityInstructions(args), ...args.instructions],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  const serializedSize = transaction.serialize().length;
  if (serializedSize > PACKET_LIMIT) {
    throw new Error(
      `Local ${args.venue} ${args.side} transaction is ${serializedSize} bytes; ` +
        `Solana packet limit is ${PACKET_LIMIT}. Configure browser lookup tables before sending.`,
    );
  }
  return {
    transaction,
    side: args.side,
    venue: args.venue,
    mint: args.mint.toBase58(),
    inputRaw: args.inputRaw,
    expectedOutputRaw: args.expectedOutputRaw,
    minimumOutputRaw: args.minimumOutputRaw,
    quoteMint: args.quoteMint.toBase58(),
    quoteDecimals: args.quoteDecimals,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    serializedSize,
  };
}

export async function buildLocalPumpBuy(args: {
  connection: Connection;
  user: PublicKey;
  mint: string | PublicKey;
  quoteInRaw: bigint;
  slippageBps?: number;
  cuLimit?: number;
  priorityMicroLamports?: number;
}): Promise<BrowserTradeBuild> {
  const mint =
    args.mint instanceof PublicKey ? args.mint : new PublicKey(args.mint);
  const { registry, token } = await resolvePumpToken(args.connection, mint);
  const { plugin, market } = await registry.resolve(
    args.connection,
    token,
    args.user,
  );
  if (market.quoteAsset.kind !== "native-sol") {
    throw new Error(
      `Pump token ${mint.toBase58()} is quoted in ${market.quoteAsset.mint.toBase58()}, not native SOL.`,
    );
  }
  const ctx = { connection: args.connection, token, user: args.user };
  const quote = await plugin.quoteBuy(
    ctx,
    market,
    rawAmount(args.quoteInRaw, market.quoteAsset),
    args.slippageBps ?? 1_500,
  );
  const built = await plugin.buildBuy(ctx, market, quote);
  return await compile({
    connection: args.connection,
    user: args.user,
    instructions: built.instructions,
    side: "buy",
    venue: market.venue,
    mint,
    inputRaw: quote.inputRaw,
    expectedOutputRaw: quote.expectedOutputRaw,
    minimumOutputRaw: quote.minimumOutputRaw,
    quoteMint: market.quoteAsset.mint,
    quoteDecimals: market.quoteAsset.decimals,
    cuLimit: args.cuLimit ?? 350_000,
    priorityMicroLamports: args.priorityMicroLamports ?? 0,
  });
}

export async function buildLocalPumpSell(args: {
  connection: Connection;
  user: PublicKey;
  mint: string | PublicKey;
  baseInRaw: bigint;
  slippageBps?: number;
  cuLimit?: number;
  priorityMicroLamports?: number;
}): Promise<BrowserTradeBuild> {
  const mint =
    args.mint instanceof PublicKey ? args.mint : new PublicKey(args.mint);
  const { registry, token } = await resolvePumpToken(args.connection, mint);
  const { plugin, market } = await registry.resolve(
    args.connection,
    token,
    args.user,
  );
  if (market.quoteAsset.kind !== "native-sol") {
    throw new Error(
      `Pump token ${mint.toBase58()} is quoted in ${market.quoteAsset.mint.toBase58()}, not native SOL.`,
    );
  }
  const ctx = { connection: args.connection, token, user: args.user };
  const quote = await plugin.quoteSell(
    ctx,
    market,
    args.baseInRaw,
    args.slippageBps ?? 1_500,
  );
  const built = await plugin.buildSell(ctx, market, quote);
  return await compile({
    connection: args.connection,
    user: args.user,
    instructions: built.instructions,
    side: "sell",
    venue: market.venue,
    mint,
    inputRaw: quote.inputRaw,
    expectedOutputRaw: quote.expectedOutputRaw,
    minimumOutputRaw: quote.minimumOutputRaw,
    quoteMint: market.quoteAsset.mint,
    quoteDecimals: market.quoteAsset.decimals,
    cuLimit: args.cuLimit ?? 350_000,
    priorityMicroLamports: args.priorityMicroLamports ?? 0,
  });
}
