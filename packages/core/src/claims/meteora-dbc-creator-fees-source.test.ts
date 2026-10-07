import { expect, test } from "bun:test";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { fixtureConnection } from "../venues/meteora/fixtures/connection.ts";
import { dbcClient, readDbcMarket, DYNAMIC_BONDING_CURVE_PROGRAM_ID } from "../venues/meteora/dbc.ts";
import { defaultPumpQuoteShell } from "../venues/pump/common.ts";
import { MeteoraDbcCreatorFeesSource } from "./meteora-dbc-creator-fees-source.ts";

const pool = new PublicKey("8UCus3tg3YUZMjsCsQg9icvQLrKpQXaKxAKCQ5icTkrB");
const mint = new PublicKey("3QEbHMK6ceYevtaCdLmBQMJgcPb9PJQpgyFBP6f6x6Rg");
test("DBC migrated pool retains creator trading fees and uses the SDK claim builder", async () => {
  const { connection, accounts } = fixtureConnection();
  connection.getMinimumBalanceForRentExemption = async () => 2_039_280;
  const state = await readDbcMarket(connection, pool);
  const creator = state.virtualPool.poolState.creator;
  state.virtualPool.poolState.creatorBaseFee = new BN(20);
  state.virtualPool.poolState.creatorQuoteFee = new BN(100);
  accounts.get(pool.toBase58())!.data = await dbcClient(connection).state.getProgram().coder.accounts.encode("virtualPool", state.virtualPool);
  const plan = await new MeteoraDbcCreatorFeesSource().resolveClaim({ connection,
    token: defaultPumpQuoteShell(mint), user: creator });
  expect(plan?.estimatedClaimRaw).toBe(100n);
  expect(plan?.meta?.claimComponents).toMatchObject([{ amountRaw: "20", quoteMint: mint.toBase58() }, { amountRaw: "100" }]);
  expect(plan?.instructions.some((ix) => ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))).toBe(true);
  expect(plan?.instructions.every((ix) => ix.keys.filter((key) => key.isSigner).every((key) => key.pubkey.equals(creator)))).toBe(true);
});

test("DBC claimant must be the pool creator", async () => {
  const { connection } = fixtureConnection();
  expect(await new MeteoraDbcCreatorFeesSource().resolveClaim({ connection, token: defaultPumpQuoteShell(mint), user: PublicKey.default })).toBeNull();
});
