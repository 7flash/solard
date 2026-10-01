// Unsigned, read-only mainnet simulation. No wallet files or send methods.
import { Connection, PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction, type Keypair, type AddressLookupTableAccount } from "@solana/web3.js";
import { Solard } from "../packages/core/src/core/solard.ts";
import { VenueRegistry } from "../packages/core/src/venues/route-resolver.ts";
import { PumpCurveVenue, PumpSwapVenue } from "../packages/core/src/venues/pump/index.ts";
import { MeteoraDbcVenue } from "../packages/core/src/venues/meteora/dbc.ts";
import { MeteoraDammV2Venue } from "../packages/core/src/venues/meteora/damm-v2.ts";
import { readMint } from "../packages/core/src/chain/state.ts";
import { verifyPoolTokenMetadata } from "../packages/core/src/venues/pump/token-metadata.ts";
import { SolardConnection, solardRpcFetch } from "../packages/core/src/chain/connection.ts";
import type { TokenRow } from "../packages/core/src/db/schema.ts";
process.env.SLRD_RPC_MAX_RPS = "2";
const connection = new SolardConnection("https://api.mainnet-beta.solana.com", "confirmed").get();
const payer = new PublicKey("4jxDfXDLRh3fJvQxPhuV5uMt4YLEsaM6QNYFuMddbCen");
const venues = new VenueRegistry().register(new PumpCurveVenue()).register(new PumpSwapVenue()).register(new MeteoraDbcVenue()).register(new MeteoraDammV2Venue());
const tokens = new Map<string, TokenRow>();
const slrd: Solard = Object.create(Solard.prototype);
Object.defineProperty(slrd, "venues", { value: venues });
slrd.connection = () => connection;
// materializedDraft uses only the public payer; this object cannot sign.
slrd.signer = () => ({ publicKey: payer }) as Keypair;
slrd.resolveTokenForExecution = async (reference) => {
  const mint = new PublicKey(String(reference));
  const previous = tokens.get(mint.toBase58());
  if (previous) return previous;
  const mintInfo = await readMint(connection, mint);
  const inspected = await venues.inspect(connection, mint);
  const token = { ...inspected, mint: mint.toBase58(), decimals: mintInfo.decimals, baseTokenProgram: mintInfo.tokenProgram.toBase58() } as TokenRow;
  Object.assign(token, await verifyPoolTokenMetadata(connection, token));
  tokens.set(token.mint, token);
  return token;
};
const results: Array<unknown> = [];
const lookupTables: Array<AddressLookupTableAccount> = [];
for (const [mint, pool, venueHint] of [
  ["3yLHGEma4ek25h8oRswBmYTJkTDdtGnrVn2ZuzV5pump", "D47qeECvhLero1oKCkMuKZ6sgsF6QGUZKnQuHXugQFTM", "pumpswap"],
  ["H6HtDYXzG8Q2hmNsU7d1MfKaTMq87odXummSNj8Rpump", "6ZTSKWDobV2jnyMmrf3vGqy1WZ62iZuQnnwycoZvSmuq", "pumpswap"],
  ["3QEbHMK6ceYevtaCdLmBQMJgcPb9PJQpgyFBP6f6x6Rg", "4CmPy9CYhVpTTEE1dWLt4ezHgn8Y3niJj9CtUQkDLstb", "meteora-damm-v2"],
] as const) {
  if (process.argv.includes("pump-only") && venueHint !== "pumpswap") continue;
  try {
    const token = { mint, pool, venueHint } as TokenRow;
    Object.assign(token, await verifyPoolTokenMetadata(connection, token)); tokens.set(mint, token);
    console.log("Building unsigned buy", mint, pool);
    const draft = await slrd.tx("public-payer").buy(mint, { sol: 0.001 }, { slippageBps: 500 }).materializedDraft();
    if (venueHint === "pumpswap" && !lookupTables.length) {
      const fundingPool = tokens.get("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn")?.pool;
      const lookupAddresses = new Set<string>();
      for (const address of [fundingPool, pool].filter((address): address is string => Boolean(address))) {
        const signatures = await connection.getSignaturesForAddress(new PublicKey(address), { limit: 3 }, "confirmed");
        for (const { signature } of signatures) {
          const response = await solardRpcFetch(connection.rpcEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 1 }],
          }) });
          const transaction = await response.json() as { result?: { transaction?: { message?: { addressTableLookups?: Array<{ accountKey: string }> } } } };
          for (const table of transaction.result?.transaction?.message?.addressTableLookups ?? []) lookupAddresses.add(new PublicKey(table.accountKey).toBase58());
        }
      }
      for (const address of [...lookupAddresses].slice(0, 10)) {
        const table = (await connection.getAddressLookupTable(new PublicKey(address))).value;
        if (table) lookupTables.push(table);
      }
      console.log("Read existing public lookup tables", lookupTables.map((table) => table.key.toBase58()));
    }
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ...draft.instructions] }).compileToV0Message(lookupTables);
    const transaction = new VersionedTransaction(message);
    const size = transaction.serialize().length;
    if (size > 1232) throw new Error(`Unsigned route requires an ALT: ${size} bytes`);
    const simulation = await connection.simulateTransaction(transaction, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    const result = { mint, pool, size, simulation: simulation.value.err, unitsConsumed: simulation.value.unitsConsumed, logs: simulation.value.logs, actions: draft.actions };
    results.push(result); console.log(JSON.stringify({ mint, pool, size, error: result.simulation, unitsConsumed: result.unitsConsumed, actions: result.actions }));
  } catch (error) { const result = { mint, error: error instanceof Error ? error.message : String(error) }; results.push(result); console.log(JSON.stringify(result)); }
}
await Bun.write(".docs/handoff-simulation.json", JSON.stringify(results, null, 2) + "\n");
