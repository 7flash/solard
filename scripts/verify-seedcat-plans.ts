import { Connection, PublicKey, TransactionMessage, type Keypair } from "@solana/web3.js";
import { readMint } from "../packages/core/src/chain/state.ts";
import { defaultPumpQuoteShell } from "../packages/core/src/venues/pump/common.ts";
import { PumpCurveVenue } from "../packages/core/src/venues/pump/pump-curve-venue.ts";
import { PumpSwapVenue } from "../packages/core/src/venues/pump/pumpswap-venue.ts";
import { fetchCurve } from "../packages/core/src/venues/pump/state.ts";
import { decodeWhitelistedQuoteMints } from "../packages/core/src/launches/pump/pairs.ts";
import { globalPda } from "../packages/core/src/venues/pump/pda.ts";
import { TransactionComposer, type ComposerHost } from "../packages/core/src/tx/composer.ts";
import type { TokenRow } from "../packages/core/src/db/schema.ts";

// Public RPC/account reads only. No secret, signer, simulation, broadcast, or DB.
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const accounts = new Map<string, Promise<Awaited<ReturnType<Connection["getAccountInfo"]>>>>();
const originalAccount = connection.getAccountInfo.bind(connection);
connection.getAccountInfo = async (address, config) => {
  const identity = address.toBase58();
  if (!accounts.has(identity)) accounts.set(identity, originalAccount(address, config));
  return accounts.get(identity)!;
};
connection.getMultipleAccountsInfo = async (addresses, config) =>
  Promise.all(addresses.map(address => connection.getAccountInfo(address, config)));
const curveVenue = new PumpCurveVenue();
const swapVenue = new PumpSwapVenue();
const tokens = new Map<string, Promise<TokenRow>>();
async function token(mint: PublicKey): Promise<TokenRow> {
  const identity = mint.toBase58();
  if (!tokens.has(identity)) tokens.set(identity, (async () => {
    const state = await readMint(connection, mint);
    const inspection = await curveVenue.inspectToken(connection, mint);
    return { ...defaultPumpQuoteShell(mint), ...inspection,
      decimals: state.decimals, baseTokenProgram: state.tokenProgram.toBase58() };
  })());
  return tokens.get(identity)!;
}
const base = new PublicKey("E4R6KvcnxvoHYBe872byyCeoyExGHja8n5Vo3JNWodus");
const baseToken = await token(base);
const curve = await fetchCurve(connection, baseToken);
if (!curve?.creator) throw new Error("SEEDCAT creator metadata unavailable");
// The base mint is a public on-curve key, used only as an instruction payer.
const user = base;
let hypotheticalBalance = 0n;
const host = {
  connection: () => connection,
  signer: () => ({ publicKey: user }) as Keypair,
  resolveTokenForExecution: async (ref: unknown) => token(new PublicKey(String(ref))),
  tokenBalance: async () => hypotheticalBalance,
  route: async (row: TokenRow) => {
    const context = { connection, token: row, user };
    for (const plugin of [curveVenue, swapVenue]) {
      const market = await plugin.resolveMarket(context);
      if (market) return { plugin, market };
    }
    throw new Error(`No native Pump route: ${row.mint}`);
  },
} as unknown as ComposerHost;
const buy = await new TransactionComposer(host, "public-user").buy(base, { sol: "0.001" }, { slippageBps: 500 }).materializedDraft();
hypotheticalBalance = BigInt(String(buy.actions[0]!.meta!.minOutputRaw));
const sell = await new TransactionComposer(host, "public-user").sell(base, { amountRaw: hypotheticalBalance, slippageBps: 500 }).materializedDraft();
const blockhash = "11111111111111111111111111111111";
function summarize(draft: typeof buy) {
  const message = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: draft.instructions }).compileToV0Message();
  const shortVecSize = (count: number): number => count < 128 ? 1 : count < 16384 ? 2 : 3;
  const estimatedUnsignedWireBytes = shortVecSize(message.header.numRequiredSignatures) + 64 * message.header.numRequiredSignatures
    + 1 + 3 + shortVecSize(message.staticAccountKeys.length) + 32 * message.staticAccountKeys.length + 32
    + shortVecSize(message.compiledInstructions.length)
    + message.compiledInstructions.reduce((size, instruction) => size + 1 + shortVecSize(instruction.accountKeyIndexes.length)
      + instruction.accountKeyIndexes.length + shortVecSize(instruction.data.length) + instruction.data.length, 0) + 1;
  let unsignedWireBytes: number | string;
  try { unsignedWireBytes = message.serialize().length + 1 + 64 * message.header.numRequiredSignatures; }
  catch (error) { unsignedWireBytes = `Oversized without ALTs: ${String(error)}`; }
  return { instructions: draft.instructions.length, uniqueStaticAccounts: message.staticAccountKeys.length,
    instructionFixture: draft.instructions.map(instruction => ({ programId: instruction.programId.toBase58(),
      data: instruction.data.toString("base64"), keys: instruction.keys.map(key => ({ pubkey: key.pubkey.toBase58(), isSigner: key.isSigner, isWritable: key.isWritable })) })),
    unsignedWireBytes, estimatedUnsignedWireBytes, exceeds1232Bytes: estimatedUnsignedWireBytes > 1232,
    action: draft.actions[0], requiredSignerCount: message.header.numRequiredSignatures };
}
const global = await connection.getAccountInfo(globalPda());
if (!global) throw new Error("Pump Global unavailable");
const listedQuoteMints = decodeWhitelistedQuoteMints(Buffer.from(global.data)).map(mint => mint.toBase58());
const quoteCurve = await fetchCurve(connection, await token(curve.quoteAsset.mint));
console.log(JSON.stringify({ validation: "read-only instruction construction; sell assumes guaranteed preceding buy output, not an observed wallet balance", base: base.toBase58(), baseDecimals: baseToken.decimals,
  quote: curve.quoteAsset.mint.toBase58(), quoteDecimals: curve.quoteAsset.decimals, quoteTokenProgram: curve.quoteAsset.tokenProgram.toBase58(),
  quoteToken: await token(curve.quoteAsset.mint), quoteEligibility: { listedQuoteMints, quoteCoinListed: listedQuoteMints.includes(curve.quoteAsset.mint.toBase58()),
    quoteOfQuote: quoteCurve?.quoteAsset.mint.toBase58(), isMayhem: quoteCurve?.isMayhemMode, complete: quoteCurve?.complete },
  publicUser: user.toBase58(), accountReads: accounts.size,
  buy: summarize(buy), sell: summarize(sell) }, null, 2));
