import { expect, test } from "bun:test";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { applyJupiterMinimum } from "./jupiter-minimum.ts";
test("absolute Jupiter sell minimum is encoded on chain without changing exact input or route", () => {
  const data=Buffer.alloc(40); Buffer.from([229,23,203,151,122,227,173,42]).copy(data);
  data.writeBigUInt64LE(123n,21);data.writeBigUInt64LE(100n,29);data.writeUInt16LE(0,37);
  const ix=new TransactionInstruction({programId:new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),keys:[],data});
  const built=applyJupiterMinimum(ix,123n,100n,80n);
  expect(built.data.readBigUInt64LE(21)).toBe(123n);expect(built.data.readBigUInt64LE(29)).toBe(80n);expect(built.data.readUInt16LE(37)).toBe(0);
  expect(built.data.subarray(0,29)).toEqual(data.subarray(0,29));expect(ix.data.readBigUInt64LE(29)).toBe(100n);
  expect(()=>applyJupiterMinimum(ix,124n,100n,80n)).toThrow("identity");
  expect(()=>applyJupiterMinimum(ix,123n,100n,101n)).toThrow("identity");
  const unknown=new TransactionInstruction({...ix,data:Buffer.alloc(40)});
  expect(()=>applyJupiterMinimum(unknown,123n,100n,80n)).toThrow("Unsupported");
});
