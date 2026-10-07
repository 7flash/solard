import { PublicKey } from "@solana/web3.js";
const SWAP_EVENT = Buffer.from([64, 198, 205, 232, 38, 8, 113, 226]);
export type CpmmSwapEvent = { pool: string; inputMint: string; outputMint: string; inputReserveBefore: bigint; outputReserveBefore: bigint;
  inputRaw: bigint; outputRaw: bigint; inputTransferFee: bigint; outputTransferFee: bigint };
/** Official raydium-cp-swap states/events.rs; older layouts without mint identity fail closed. */
export function decodeCpmmSwap(data: Buffer): CpmmSwapEvent | null {
  if (data.length < 170 || !data.subarray(0, 8).equals(SWAP_EVENT)) return null;
  return { pool: new PublicKey(data.subarray(8, 40)).toBase58(), inputReserveBefore: data.readBigUInt64LE(40), outputReserveBefore: data.readBigUInt64LE(48),
    inputRaw: data.readBigUInt64LE(56), outputRaw: data.readBigUInt64LE(64), inputTransferFee: data.readBigUInt64LE(72), outputTransferFee: data.readBigUInt64LE(80),
    inputMint: new PublicKey(data.subarray(89, 121)).toBase58(), outputMint: new PublicKey(data.subarray(121, 153)).toBase58() };
}
