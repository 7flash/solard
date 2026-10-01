import { getAccountLenForMint, getMint, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemInstruction, SystemProgram, type Connection } from "@solana/web3.js";
import type { PlannedTransaction } from "./types.ts";
import { TradePreSubmissionError } from "./trade-errors.ts";
export async function checkPlanBalance(connection: Connection, plan: PlannedTransaction): Promise<void> {
  const payer = plan.transaction.message.staticAccountKeys?.[0] ?? plan.payer;
  const [balance, fee] = await Promise.all([connection.getBalance(payer, "confirmed"), connection.getFeeForMessage(plan.transaction.message, "confirmed")]);
  if (fee.value == null) throw new TradePreSubmissionError(Object.assign(new Error("Unable to estimate transaction fee"), { code: "FEE_UNAVAILABLE" }));
  let transfers = 0n; let rent = 0n;
  const seen = new Set<string>();
  for (const instruction of plan.draft.instructions) {
    if (instruction.programId.equals(SystemProgram.programId)) {
      const kind = SystemInstruction.decodeInstructionType(instruction);
      if (kind === "Transfer") { const transfer = SystemInstruction.decodeTransfer(instruction); if (transfer.fromPubkey.equals(payer)) transfers += BigInt(transfer.lamports); }
      if (kind === "Create") { const create = SystemInstruction.decodeCreateAccount(instruction); if (create.fromPubkey.equals(payer)) rent += BigInt(create.lamports); }
    }
    if (instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && instruction.keys[0]?.pubkey.equals(payer)) {
      const address = instruction.keys[1]!.pubkey;
      if (seen.has(address.toBase58())) continue;
      seen.add(address.toBase58());
      if (!await connection.getAccountInfo(address, "confirmed")) {
        const mint = await getMint(connection, instruction.keys[3]!.pubkey, "confirmed", instruction.keys[5]!.pubkey);
        rent += BigInt(await connection.getMinimumBalanceForRentExemption(getAccountLenForMint(mint), "confirmed"));
      }
    }
  }
  const buyPrincipal = plan.draft.actions.filter((action) => action.kind === "buy").reduce((total, action) => total + BigInt(String(action.meta?.inputRaw ?? 0)), 0n);
  const principal = transfers > buyPrincipal ? transfers : buyPrincipal;
  const required = principal + BigInt(fee.value) + rent;
  if (BigInt(balance) < required) throw new TradePreSubmissionError(Object.assign(new Error(`Insufficient SOL: need ${required} lamports including ${rent} account rent; available ${balance}`), {
    code: rent > 0n ? "INSUFFICIENT_SOL_FOR_RENT" : "INSUFFICIENT_SOL", requiredLamports: required, availableLamports: BigInt(balance),
  }));
}
