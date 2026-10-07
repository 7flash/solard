import { test, expect } from "bun:test";
import { Keypair, type Connection, type PublicKey } from "@solana/web3.js";
import { CREATE_CPMM_POOL_PROGRAM, CpmmPoolInfoLayout } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { decodeCpmmSwap } from "./raydium-cpmm-events.ts";
import { subscribeTrades } from "./launch-trades.ts";
function event(pool: PublicKey, mint: PublicKey) {
  const data = Buffer.alloc(170); Buffer.from([64,198,205,232,38,8,113,226]).copy(data);
  pool.toBuffer().copy(data,8); data.writeBigUInt64LE(1000000000n,40); data.writeBigUInt64LE(100000000000n,48);
  data.writeBigUInt64LE(1000000n,56); data.writeBigUInt64LE(99900n,64); data[88] = 1;
  NATIVE_MINT.toBuffer().copy(data,89); mint.toBuffer().copy(data,121);
  return data;
}
test("CPMM decoding requires the mint-bearing official event layout", () => {
  const mint = Keypair.generate().publicKey, pool = Keypair.generate().publicKey;
  expect(decodeCpmmSwap(event(pool,mint))).toMatchObject({ pool: pool.toBase58(), outputMint: mint.toBase58(), inputRaw: 1000000n });
  expect(decodeCpmmSwap(event(pool,mint).subarray(0,89))).toBeNull();
});
test("CPMM live prices verify each pool identity and cannot attribute another pool", async () => {
  const mint = Keypair.generate().publicKey, pool = Keypair.generate().publicKey, otherPool = Keypair.generate().publicKey, otherMint = Keypair.generate().publicKey;
  const accounts = new Map<string, any>();
  for (const [address, base] of [[pool,mint],[otherPool,otherMint]] as const) {
    const data = Buffer.alloc(CpmmPoolInfoLayout.span); Buffer.from([247,237,227,245,215,195,222,70]).copy(data);
    base.toBuffer().copy(data,CpmmPoolInfoLayout.offsetOf("mintA")); NATIVE_MINT.toBuffer().copy(data,CpmmPoolInfoLayout.offsetOf("mintB"));
    TOKEN_PROGRAM_ID.toBuffer().copy(data,CpmmPoolInfoLayout.offsetOf("mintProgramA")); TOKEN_PROGRAM_ID.toBuffer().copy(data,CpmmPoolInfoLayout.offsetOf("mintProgramB"));
    accounts.set(address.toBase58(), { data, owner: CREATE_CPMM_POOL_PROGRAM });
  }
  for (const [address, decimals] of [[mint,6],[NATIVE_MINT,9]] as const) {
    const data = Buffer.alloc(82); data[44]=decimals; data[45]=1;data.writeBigUInt64LE(1000000000000000n,36);
    accounts.set(address.toBase58(), { data, owner: TOKEN_PROGRAM_ID });
  }
  let callback: any;
  const connection = { onLogs: (_: any, fn: any) => { callback = fn; return 1; }, removeOnLogsListener: async () => {},
    getAccountInfo: async (key: PublicKey) => accounts.get(key.toBase58()) ?? null,
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(key => accounts.get(key.toBase58()) ?? null),
    getTokenSupply: async () => ({ value: { amount: "1000000000000000", decimals: 6 } }),
  } as unknown as Connection;
  const trades: any[] = [];
  const subscription = await subscribeTrades({ connection, tokens: [mint.toBase58()], venues: ["raydium-cpmm"], solUsd: 100, onTrade: trade => { trades.push(trade); } });
  callback({ signature: "multi-pool", err: null, logs: [`Program ${CREATE_CPMM_POOL_PROGRAM} invoke [1]`,
    `Program data: ${event(otherPool,mint).toString("base64")}`, `Program data: ${event(pool,mint).toString("base64")}`, `Program ${CREATE_CPMM_POOL_PROGRAM} success`] }, { slot: 12 });
  await Bun.sleep(20);
  expect(trades).toHaveLength(1); expect(trades[0].pool).toBe(pool.toBase58());
  expect(trades[0].market.priceSol).toBeCloseTo(0.00001);
  expect(trades[0].market.marketCapSol).toBeCloseTo(10000);
  expect(trades[0].market.supplyRaw).toBe(1000000000000000n);
  await subscription.close();
});
