import { PublicKey } from "@solana/web3.js";
import {
  readMint,
  sol,
  tokenAmount,
  transferTokenIxs,
  estimatePlanFee,
  tradeResult,
  type SenderId,
  type Solard,
} from "@solard/core";
import { tradeFeeOptions } from "./trade-fees.ts";

import { resolveDestinationRef } from "../refs.ts";

const CANONICAL_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type TransferCliFlags = ReadonlyMap<string, string>;

type RunTransferCommandArgs = {
  slrd: Solard;
  values: string[];
  flags: TransferCliFlags;
};

function requiredFlag(flags: TransferCliFlags, key: string): string {
  const value = flags.get(key);
  if (!value || value === "true") {
    throw new Error(`Missing --${key} <value>`);
  }
  return value;
}

function senderId(flags: TransferCliFlags): SenderId {
  const value = flags.get("sender") ?? "rpc";
  if (value !== "rpc" && value !== "helius" && value !== "jito") {
    throw new Error(`Invalid --sender: ${value}`);
  }
  return value;
}

function nonNegativeInteger(
  flags: TransferCliFlags,
  key: string,
  fallback: number,
): number {
  const raw = flags.get(key);
  const value = raw == null ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${key} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(
  flags: TransferCliFlags,
  key: string,
  fallback: number,
): number {
  const value = nonNegativeInteger(flags, key, fallback);
  if (value <= 0) throw new Error(`--${key} must be a positive integer`);
  return value;
}

export async function runTransferCommand({
  slrd,
  values,
  flags,
}: RunTransferCommandArgs): Promise<Record<string, unknown>> {
  const recipientInput = values[0] === "sol" ? values[1] : values[0];
  if (!recipientInput) {
    throw new Error(
      "Usage: slrd transfer <contact|wallet|address> --wallet <wallet> (--sol <amount> | --token <USDC|mint> --amount <ui>) [--sender rpc|helius|jito] [--simulate-only]",
    );
  }

  const recipient = resolveDestinationRef(slrd, recipientInput);
  const wallet = requiredFlag(flags, "wallet");
  const via = senderId(flags);
  const tokenRef = flags.get("token")?.trim();
  const solValue = flags.get("sol")?.trim();

  if (Boolean(tokenRef) === Boolean(solValue)) {
    throw new Error(
      "Transfer requires exactly one of --sol <amount> or --token <USDC|mint> --amount <ui>",
    );
  }

  const cuLimit = positiveInteger(
    flags,
    "cu-limit",
    tokenRef ? 30_000 : 10_000,
  );
  const feeOptions = tradeFeeOptions(flags);
  const priorityMicroLamports = feeOptions.priorityFee.microLamports;
  const executionOptions = {
    ...feeOptions,
    priorityFee: { cuLimit, microLamports: priorityMicroLamports },
    skipSimulation: flags.has("skip-simulation"),
    skipPreflight: flags.has("skip-preflight") || flags.has("skip-simulation"),
  };

  if (tokenRef) {
    const amountUi = requiredFlag(flags, "amount");
    const normalizedToken = tokenRef.replace(/^\$/, "").trim();
    const isUsdc = normalizedToken.toUpperCase() === "USDC";
    const mint = new PublicKey(isUsdc ? CANONICAL_USDC_MINT : normalizedToken);
    const mintState = await readMint(slrd.connection(), mint, slrd.cache);
    const amountRaw = tokenAmount(
      amountUi,
      mint,
      mintState.decimals,
      mintState.tokenProgram,
    ).raw;
    if (amountRaw <= 0n) {
      throw new Error("Token transfer amount must be greater than zero");
    }

    const owner = slrd.signer(wallet).publicKey;
    const destinationOwner = new PublicKey(recipient.address);
    const transfer = transferTokenIxs({
      payer: owner,
      owner,
      recipient: destinationOwner,
      mint,
      amountRaw,
      decimals: mintState.decimals,
      tokenProgram: mintState.tokenProgram,
    });

    const composer = slrd
      .tx(wallet)
      .addMany(transfer.instructions, {
        kind: "transfer-token",
        mint,
        recipient: destinationOwner,
        meta: { raw: amountRaw.toString() },
      })
      .track({
        address: transfer.destination,
        kind: "token",
        mint,
      })
      .priorityFee({ cuLimit, microLamports: priorityMicroLamports });

    if (flags.has("simulate-only")) {
      const prepared = await slrd.prepareTradePlan(
        wallet,
        await composer.build(),
        executionOptions,
      );
      const result = await slrd.simulatePlan(prepared.plan);
      return {
        mode: "simulation",
        wallet,
        recipient,
        token: isUsdc ? "USDC" : mint.toBase58(),
        mint: mint.toBase58(),
        amount: amountUi,
        decimals: mintState.decimals,
        amountRaw,
        result,
        feeEstimate: await estimatePlanFee(slrd.connection(), prepared.plan),
        priorityMicroLamports: prepared.priorityMicroLamports,
        cuLimit,
      };
    }

    const execution = await slrd.executeTradePlan(
      wallet,
      () => composer.build(),
      via,
      "transfer-token",
      executionOptions,
    );
    const receipt = tradeResult(
      execution.receipt,
      execution.attempts,
      execution.submission.executionId,
    );

    return {
      ...receipt,
      wallet,
      recipient,
      token: isUsdc ? "USDC" : mint.toBase58(),
      mint: mint.toBase58(),
      amount: amountUi,
      decimals: mintState.decimals,
      amountRaw,
    };
  }

  const amount = solValue!;
  const composer = slrd
    .tx(wallet)
    .transferSol(recipient.address, sol(amount))
    .priorityFee({ cuLimit, microLamports: priorityMicroLamports });

  if (flags.has("simulate-only")) {
    const prepared = await slrd.prepareTradePlan(
      wallet,
      await composer.build(),
      executionOptions,
    );
    const result = await slrd.simulatePlan(prepared.plan);
    return {
      mode: "simulation",
      wallet,
      recipient,
      sol: amount,
      result,
      feeEstimate: await estimatePlanFee(slrd.connection(), prepared.plan),
      priorityMicroLamports: prepared.priorityMicroLamports,
      cuLimit,
    };
  }

  const execution = await slrd.executeTradePlan(
    wallet,
    () => composer.build(),
    via,
    "transfer-sol",
    executionOptions,
  );
  const receipt = tradeResult(
    execution.receipt,
    execution.attempts,
    execution.submission.executionId,
  );

  return { ...receipt, recipient, wallet, sol: amount };
}
