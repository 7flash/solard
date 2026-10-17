import { test, expect } from "bun:test";
import { PublicKey, SystemProgram, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SOL_ASSET } from "../core/amounts.ts";
import { Solard } from "../core/solard.ts";

const payer = new PublicKey(new Uint8Array(32).fill(29));
const mint = new PublicKey(new Uint8Array(32).fill(30));
const pool = new PublicKey(new Uint8Array(32).fill(31));

test("public unsigned composer constructs and simulates without managed wallet signer", async () => {
  let signerReads = 0;
  let sigVerify: boolean | undefined;
  const core = Object.create(Solard.prototype) as Solard;
  core.signer = (() => {
    signerReads++;
    throw new Error("private wallet must never be accessed");
  }) as any;
  const connection = {
    async getMultipleAccountsInfo(keys: PublicKey[]) { return keys.map(() => null); },
    async simulateTransaction(_value: unknown, options: { sigVerify?: boolean }) {
      sigVerify = options.sigVerify;
      return { value: { err: null, logs: ["unsigned simulated"], unitsConsumed: 25_000 } };
    },
  } as unknown as Connection;
  core.connection = () => connection;
  core.resolveTokenForExecution = async () => ({
    mint: mint.toBase58(), decimals: 6, baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
  }) as any;
  core.route = async () => ({ plugin: {
    id: "fixture",
    async quoteBuy() { return { expectedOutputRaw: 120n, minimumOutputRaw: 110n }; },
    async buildBuy() { return {
      instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: pool, lamports: 1_000_000 })],
      expectedOutputRaw: 120n, minOutputRaw: 110n,
    }; },
  }, market: {
    mint, venue: "pumpswap", quoteAsset: SOL_ASSET,
    baseTokenProgram: TOKEN_PROGRAM_ID, metadata: { pool },
  } }) as any;
  Object.defineProperty(core, "blockhash", { value: { get: async () => ({
    blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 10,
  }) } });
  Object.defineProperty(core, "alts", { value: { list: () => [] } });
  const args = { payer, mint, sol: "0.001", slippageBps: 500 };
  const draft = await core.prepareUnsignedBuyDraft(args);
  expect(draft.actions).toHaveLength(1);
  expect(draft.actions[0]?.meta?.minOutputRaw).toBe("110");
  const { plan, simulation } = await core.simulateUnsignedBuy(args);
  expect(plan.serializedSize).toBeLessThanOrEqual(1232);
  expect(plan.transaction.signatures.every(signature => signature.every(byte => byte === 0))).toBe(true);
  expect(simulation.success).toBe(true);
  expect(sigVerify).toBe(false);
  expect(signerReads).toBe(0);
});
