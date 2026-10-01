// Read-only mainnet account inspection. No wallet, signer, or send methods.
import { Connection, PublicKey } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "../packages/core/node_modules/@meteora-ag/dynamic-bonding-curve-sdk";
import { readDbcMarket } from "../packages/core/src/venues/meteora/dbc.ts";
import { fetchPool } from "../packages/core/src/venues/pump/state.ts";
import { readMint } from "../packages/core/src/chain/state.ts";
import { CpAmm } from "../packages/core/node_modules/@meteora-ag/cp-amm-sdk";
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const addresses = new Set<string>();
const client = new DynamicBondingCurveClient(connection, "confirmed");
const dbcPool = new PublicKey("8UCus3tg3YUZMjsCsQg9icvQLrKpQXaKxAKCQ5icTkrB");
const virtualPool = await client.state.getPool(dbcPool);
if (!virtualPool) throw new Error("Missing THICC pool");
const poolState = virtualPool.poolState;
console.log("THICC DBC", { base: poolState.baseMint.toBase58(), config: poolState.config.toBase58(), migrated: poolState.isMigrated, progress: poolState.migrationProgress });
const market = await readDbcMarket(connection, dbcPool);
const migratedPools = await new CpAmm(connection).fetchPoolStatesByTokenMint(poolState.baseMint);
for (const discovered of migratedPools) {
  const state = discovered.account;
  console.log("THICC DAMM v2", { pool: discovered.publicKey.toBase58(), tokenA: state.tokenAMint.toBase58(), tokenB: state.tokenBMint.toBase58() });
  for (const address of [discovered.publicKey, state.tokenAMint, state.tokenBMint, state.tokenAVault, state.tokenBVault]) addresses.add(address.toBase58());
}
for (const address of [dbcPool, poolState.config, poolState.baseMint, poolState.baseVault, poolState.quoteVault, market.config.quoteMint]) addresses.add(address.toBase58());
for (const poolText of ["D47qeECvhLero1oKCkMuKZ6sgsF6QGUZKnQuHXugQFTM", "6ZTSKWDobV2jnyMmrf3vGqy1WZ62iZuQnnwycoZvSmuq"]) {
  const pool = await fetchPool(connection, new PublicKey(poolText));
  const [base, quote] = await Promise.all([readMint(connection, pool.baseMint), readMint(connection, pool.quoteMint)]);
  console.log("PumpSwap", { pool: poolText, base: pool.baseMint.toBase58(), quote: pool.quoteMint.toBase58(), baseProgram: base.tokenProgram.toBase58(), quoteProgram: quote.tokenProgram.toBase58(), baseDecimals: base.decimals, quoteDecimals: quote.decimals });
  for (const address of [pool.address, pool.baseMint, pool.quoteMint, pool.baseTokenAccount, pool.quoteTokenAccount]) addresses.add(address.toBase58());
}
const keys = [...addresses];
const response = await connection.getMultipleAccountsInfoAndContext(keys.map((key) => new PublicKey(key)), "confirmed");
const snapshot = { cluster: "mainnet-beta", slot: response.context.slot, capturedAt: new Date().toISOString(), accounts: Object.fromEntries(keys.map((key, index) => {
  const account = response.value[index];
  if (!account) throw new Error(`Missing account ${key}`);
  return [key, { owner: account.owner.toBase58(), data: account.data.toString("base64"), lamports: account.lamports, executable: account.executable }];
})) };
await Bun.write("packages/core/src/venues/meteora/fixtures/handoff-mainnet.json", JSON.stringify(snapshot, null, 2) + "\n");
console.log("Saved public account fixture", response.context.slot, keys.length);
