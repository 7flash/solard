import { PublicKey, TransactionInstruction } from "@solana/web3.js";
const program = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
// jup-ag/instruction-parser/src/idl/jupiter.ts: exact-input route/sharedAccountsRoute
// end in inAmount:u64, quotedOutAmount:u64, slippageBps:u16, platformFeeBps:u8.
const discriminators = [Buffer.from([229,23,203,151,122,227,173,42]), Buffer.from([193,32,155,51,65,214,156,129])];
export function applyJupiterMinimum(ix: TransactionInstruction, input: bigint, expected: bigint, minimum: bigint): TransactionInstruction {
  const data = Buffer.from(ix.data);
  if (!ix.programId.equals(program) || data.length < 31 || !discriminators.some(d => data.subarray(0,8).equals(d)))
    throw Error("Unsupported Jupiter instruction for verified absolute minimum");
  if (minimum <= 0n || minimum > expected || data.readBigUInt64LE(data.length-19) !== input || data.readBigUInt64LE(data.length-11) !== expected)
    throw Error("Jupiter instruction input/output identity differs from quote");
  // Zero slippage relative to the caller's floor, rather than the earlier spot quote.
  data.writeBigUInt64LE(minimum, data.length-11);
  data.writeUInt16LE(0, data.length-3);
  return new TransactionInstruction({programId:ix.programId,keys:ix.keys,data});
}
