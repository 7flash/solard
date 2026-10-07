import { PublicKey, SystemInstruction, SystemProgram } from "@solana/web3.js";
import type { TransactionDraft } from "./types.ts";

export type HeliusLandingTier = "helius-swqos" | "helius-max";
// Verified 2026-10-07: https://www.helius.dev/docs/sending-transactions/sender
export const HELIUS_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
] as const;

export function heliusMinimumTip(tier: HeliusLandingTier): number {
  return tier === "helius-swqos" ? 5_000 : 1_000_000;
}

/** Materialize before compilation/signing; subsequent fee preparation never adds another tip. */
export function addHeliusLandingTip(
  draft: TransactionDraft,
  payer: PublicKey,
  tier: HeliusLandingTier,
  options: { tipLamports?: number; tipAccount?: PublicKey } = {},
): { draft: TransactionDraft; tipLamports: number } {
  const minimum = heliusMinimumTip(tier);
  const requested = options.tipLamports ?? minimum;
  if (!Number.isSafeInteger(requested) || requested < minimum)
    throw new Error(`Helius ${tier} requires a tip of at least ${minimum} lamports`);
  if (options.tipAccount && !HELIUS_TIP_ACCOUNTS.includes(options.tipAccount.toBase58() as typeof HELIUS_TIP_ACCOUNTS[number]))
    throw new Error("Helius tip account is not a published Sender account");
  const existingIndex = draft.actions.findIndex((action) => action.kind === "landing-tip" && action.meta?.sender === "helius");
  const previous = existingIndex >= 0 ? draft.actions[existingIndex]! : undefined;
  const instructionIndex = previous ? Number(previous.meta?.instructionIndex) : draft.instructions.length;
  let recipient = options.tipAccount;
  let amount = requested;
  if (previous) {
    const instruction = draft.instructions[instructionIndex];
    if (!Number.isSafeInteger(instructionIndex) || !instruction) throw new Error("Helius landing tip metadata has no matching instruction");
    const transfer = SystemInstruction.decodeTransfer(instruction);
    if (!transfer.fromPubkey.equals(payer) || !HELIUS_TIP_ACCOUNTS.includes(transfer.toPubkey.toBase58() as typeof HELIUS_TIP_ACCOUNTS[number]) || BigInt(String(previous.meta?.tipLamports)) !== transfer.lamports)
      throw new Error("Helius landing tip metadata does not match its transfer");
    recipient ??= transfer.toPubkey;
    amount = Math.max(requested, Number(transfer.lamports));
  }
  recipient ??= new PublicKey(HELIUS_TIP_ACCOUNTS[Math.floor(Math.random() * HELIUS_TIP_ACCOUNTS.length)]!);
  const instructions = [...draft.instructions];
  instructions[instructionIndex] = SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: amount });
  const actions = [...draft.actions];
  const action = { kind: "landing-tip", recipient, meta: { sender: "helius", tier, lamports: amount, tipLamports: amount, instructionIndex } };
  if (previous) actions[existingIndex] = action;
  else actions.push(action);
  return { draft: { ...draft, instructions, actions }, tipLamports: amount };
}
