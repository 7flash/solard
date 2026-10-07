import { test, expect } from "bun:test";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { checkPlanBalance } from "./balance-preflight.ts";
test("SOL principal and fee are checked; rent produces a typed required-amount error", async () => {
  const payer = Keypair.generate().publicKey;
  const plan = { payer, transaction: { message: {} }, draft: { actions: [{ kind: "buy", meta: { inputRaw: "1000000" } }], instructions: [SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: Keypair.generate().publicKey, lamports: 2000000, space: 165, programId: SystemProgram.programId })] } } as any;
  const connection = { getBalance: async () => 1005000, getFeeForMessage: async () => ({ value: 5000 }) } as any;
  await expect(checkPlanBalance(connection, plan)).rejects.toMatchObject({ phase: "before-submission", code: "INSUFFICIENT_SOL_FOR_RENT", requiredLamports: 3005000n });
  plan.draft.instructions = []; await checkPlanBalance(connection, plan);
  connection.getBalance = async () => 1004999;
  await expect(checkPlanBalance(connection, plan)).rejects.toMatchObject({ code: "INSUFFICIENT_SOL" });
});

test("batches missing ATAs and Token-2022 mint reads; caches mint lengths and rent", async () => {
  const { createAssociatedTokenAccountIdempotentInstruction, TOKEN_2022_PROGRAM_ID, ExtensionType, getMintLen, ACCOUNT_SIZE, AccountType, getAccountLen } = await import("@solana/spl-token");
  const payer = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const atas = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const data = Buffer.alloc(getMintLen([ExtensionType.TransferFeeConfig]));
  data[44] = 6; data[45] = 1; data[ACCOUNT_SIZE] = AccountType.Mint;
  data.writeUInt16LE(ExtensionType.TransferFeeConfig, ACCOUNT_SIZE + 1);
  data.writeUInt16LE(108, ACCOUNT_SIZE + 3);
  const mintAccount = { owner: TOKEN_2022_PROGRAM_ID, data, executable: false, lamports: 1000000, rentEpoch: 0 };
  const plan = { payer, transaction: { message: {} }, draft: { actions: [], instructions: atas.map(ata => createAssociatedTokenAccountIdempotentInstruction(payer, ata, payer, mint, TOKEN_2022_PROGRAM_ID)) } } as any;
  const calls: string[][] = []; const sizes: number[] = [];
  const connection = {
    getBalance: async () => 10000000, getFeeForMessage: async () => ({ value: 5000 }),
    getMultipleAccountsInfo: async (addresses: any[]) => { calls.push(addresses.map(a => a.toBase58())); return addresses.map(a => a.equals(mint) ? mintAccount : null); },
    getMinimumBalanceForRentExemption: async (size: number) => { sizes.push(size); return 2000000; },
  } as any;
  await checkPlanBalance(connection, plan);
  expect(calls[0]).toHaveLength(3);
  expect(sizes).toEqual([getAccountLen([ExtensionType.TransferFeeAmount])]);
  await checkPlanBalance(connection, plan);
  expect(calls[1]).toHaveLength(2);
  expect(sizes).toHaveLength(1);
  connection.getBalance = async () => 4004999;
  await expect(checkPlanBalance(connection, plan)).rejects.toMatchObject({ code: "INSUFFICIENT_SOL_FOR_RENT", requiredLamports: 4005000n });
  // A different connection/cluster must validate ownership rather than reusing metadata.
  const wrong = { ...connection, getMultipleAccountsInfo: async (addresses: any[]) => addresses.map(a => a.equals(mint) ? { ...mintAccount, owner: SystemProgram.programId } : null) };
  await expect(checkPlanBalance(wrong as any, plan)).rejects.toThrow();
});

test("pump principal plus Sender tip is counted without double-counting WSOL transfers", async () => {
  const payer = Keypair.generate().publicKey;
  const tip = SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 5000 });
  const plan = { payer, transaction: { message: {} }, draft: { actions: [{ kind: "buy", meta: { inputRaw: "1000000" } }, { kind: "helius-tip", meta: { lamports: "5000" } }], instructions: [tip] } } as any;
  const connection = { getBalance: async () => 1009999, getFeeForMessage: async () => ({ value: 5000 }) } as any;
  await expect(checkPlanBalance(connection, plan)).rejects.toMatchObject({ requiredLamports: 1010000n });
  plan.draft.instructions.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1000000 }));
  connection.getBalance = async () => 1010000;
  await checkPlanBalance(connection, plan);
});
