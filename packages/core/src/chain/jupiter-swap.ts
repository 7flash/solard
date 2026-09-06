import { NATIVE_MINT } from "@solana/spl-token";
import { Keypair, VersionedTransaction } from "@solana/web3.js";

import { createSolardMeasure } from "../core/log.ts";
import {
  jupiterExecuteLog,
  jupiterQuoteLog,
  short,
} from "../core/log-result.ts";
import { measured, measuredSync } from "../core/measured.ts";
import { JupiterExecutionError, JupiterRouteError } from "./jupiter-errors.ts";
import {
  defaultJupiterTransport,
  type JupiterTransport,
} from "./jupiter-transport.ts";
import type {
  JupiterSwapExecuteResult,
  JupiterSwapOrder,
  JupiterSwapQuote,
} from "./jupiter-swap-types.ts";

export type {
  JupiterSwapExecuteResult,
  JupiterSwapOrder,
  JupiterSwapQuote,
} from "./jupiter-swap-types.ts";

const m = createSolardMeasure("jupiter");

export type JupiterSwapRequest = {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
};

export type JupiterSwapExecuteRequest = JupiterSwapRequest & {
  signer: Keypair;
};

export type JupiterSwapService = {
  quote(args: JupiterSwapRequest): Promise<JupiterSwapQuote>;
  execute(args: JupiterSwapExecuteRequest): Promise<JupiterSwapExecuteResult>;
};

function assertSwapArgs(args: JupiterSwapRequest): void {
  if (args.amountRaw <= 0n) {
    throw new Error("Jupiter swap amount must be positive");
  }
  if (args.inputMint === args.outputMint) {
    throw new Error("Jupiter swap input and output mints must differ");
  }
}

function parsedOutAmount(order: JupiterSwapOrder): bigint {
  const value = String(order.outAmount ?? "0");
  return /^\d+$/.test(value) ? BigInt(value) : 0n;
}

export function createJupiterSwapService(
  transport: JupiterTransport,
): JupiterSwapService {
  return {
    async quote(args) {
      assertSwapArgs(args);

      return await measured(
        m,
        "quote",
        async () => {
          const order = await transport.fetchOrder(args);
          const outAmountRaw = parsedOutAmount(order);

          if (order.errorCode != null || outAmountRaw <= 0n) {
            throw new JupiterRouteError(
              order.errorMessage ??
                `Jupiter has no executable route from ${args.inputMint} to ${args.outputMint}`,
            );
          }

          return {
            inputMint: args.inputMint,
            outputMint: args.outputMint,
            amountRaw: args.amountRaw,
            outAmountRaw,
            router: order.router ?? null,
            feeBps: typeof order.feeBps === "number" ? order.feeBps : null,
            feeMint: order.feeMint ?? null,
          };
        },
        jupiterQuoteLog,
      );
    },

    async execute(args) {
      assertSwapArgs(args);

      return await measured(
        m,
        "execute",
        async () => {
          const order = await transport.fetchOrder({
            inputMint: args.inputMint,
            outputMint: args.outputMint,
            amountRaw: args.amountRaw,
            taker: args.signer.publicKey.toBase58(),
          });

          if (!order.transaction || !order.requestId) {
            throw new JupiterRouteError(
              order.errorMessage ??
                `Jupiter could not build a transaction from ${args.inputMint} to ${args.outputMint}`,
            );
          }

          const signedTransaction = measuredSync(
            m,
            "sign",
            () => {
              const transaction = VersionedTransaction.deserialize(
                Buffer.from(order.transaction!, "base64"),
              );
              transaction.sign([args.signer]);
              return Buffer.from(transaction.serialize()).toString("base64");
            },
            (serialized) => ({
              wallet: short(args.signer.publicKey.toBase58()),
              serializedBytes: Buffer.from(serialized, "base64").length,
            }),
          );

          const result = await transport.executeSignedTransaction({
            signedTransaction,
            requestId: order.requestId,
          });

          if (result.status !== "Success" || result.code !== 0) {
            throw new JupiterExecutionError(
              result.code,
              result.error ?? "unknown error",
            );
          }

          return result;
        },
        jupiterExecuteLog,
      );
    },
  };
}

const service = createJupiterSwapService(defaultJupiterTransport());

export async function quoteJupiterSwap(
  args: JupiterSwapRequest,
): Promise<JupiterSwapQuote> {
  return await service.quote(args);
}

export async function executeJupiterSwap(
  args: JupiterSwapExecuteRequest,
): Promise<JupiterSwapExecuteResult> {
  return await service.execute(args);
}

export async function quoteJupiterTokenToSol(args: {
  inputMint: string;
  amountRaw: bigint;
}): Promise<JupiterSwapQuote> {
  return await quoteJupiterSwap({
    inputMint: args.inputMint,
    outputMint: NATIVE_MINT.toBase58(),
    amountRaw: args.amountRaw,
  });
}

export async function executeJupiterTokenToSol(args: {
  inputMint: string;
  amountRaw: bigint;
  signer: Keypair;
}): Promise<JupiterSwapExecuteResult> {
  return await executeJupiterSwap({
    inputMint: args.inputMint,
    outputMint: NATIVE_MINT.toBase58(),
    amountRaw: args.amountRaw,
    signer: args.signer,
  });
}
