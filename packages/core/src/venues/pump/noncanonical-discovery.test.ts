import { expect, test } from "bun:test";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { pumpAmmJson } from "@pump-fun/pump-swap-sdk";
import { discoverPumpSwapPool, PumpSwapVenue } from "./pumpswap-venue.ts";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, WRAPPED_SOL_MINT } from "./constants.ts";
import { globalPda } from "./pda.ts";
import { quoteSolLoader } from "../../market/launch-trades.ts";
import { Solard } from "../../core/solard.ts";
import type { TokenRow } from "../../db/schema.ts";

const mint = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
const noncanonical = new PublicKey("539m4mVWt6iduB6W8rDGPMarzNCMesuqY5eUTiiYHAgR");
const creator = new PublicKey("6YUF9bvmbYSVopieXE7boHvByDP9U5ERJoUP6NfcpP9t");
const usdc = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const baseVault = new PublicKey(new Uint8Array(32).fill(91));
const quoteVault = new PublicKey(new Uint8Array(32).fill(92));
function account(data: Buffer, owner: PublicKey): AccountInfo<Buffer> {
  return { data, owner, executable: false, lamports: 1, rentEpoch: 0 };
}
function mintData(decimals: number) {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(975357022505512n, 36);
  data[44] = decimals; data[45] = 1;
  return data;
}
function tokenAccount(token: PublicKey, amount: bigint) {
  const data = Buffer.alloc(165);
  token.toBuffer().copy(data, 0);
  creator.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return data;
}
function chain() {
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const put = (key: PublicKey, data: Buffer, owner: PublicKey) =>
    accounts.set(key.toBase58(), account(data, owner));
  const global = Buffer.alloc(1045);
  Buffer.from([167, 232, 232, 177, 200, 108, 114, 127]).copy(global);
  usdc.toBuffer().copy(global, 1013);
  put(globalPda(), global, PUMP_PROGRAM_ID);
  put(usdc, mintData(6), TOKEN_PROGRAM_ID);
  put(mint, mintData(6), TOKEN_2022_PROGRAM_ID);
  put(WRAPPED_SOL_MINT, mintData(9), TOKEN_PROGRAM_ID);
  const pool = Buffer.alloc(261);
  Buffer.from(pumpAmmJson.accounts.find(row => row.name.toLowerCase() === "pool")!.discriminator).copy(pool);
  creator.toBuffer().copy(pool, 11);
  mint.toBuffer().copy(pool, 43);
  WRAPPED_SOL_MINT.toBuffer().copy(pool, 75);
  baseVault.toBuffer().copy(pool, 139);
  quoteVault.toBuffer().copy(pool, 171);
  creator.toBuffer().copy(pool, 211);
  put(noncanonical, pool, PUMP_AMM_PROGRAM_ID);
  put(baseVault, tokenAccount(mint, 318592434112n), TOKEN_2022_PROGRAM_ID);
  put(quoteVault, tokenAccount(WRAPPED_SOL_MINT, 13855541098n), TOKEN_PROGRAM_ID);
  let broadScans = 0;
  const batches: number[] = [];
  const connection = {
    async getAccountInfo(address: PublicKey) { return accounts.get(address.toBase58()) ?? null; },
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      if (keys.length > 10) throw new Error("A maximum of 10 accounts is allowed");
      batches.push(keys.length);
      return keys.map(key => accounts.get(key.toBase58()) ?? null);
    },
    async getSignaturesForAddress(_address: PublicKey, options: { limit: number }) {
      expect(options.limit).toBeLessThanOrEqual(64);
      return [{ signature: "mint-swap" }];
    },
    async getParsedTransaction() { return { meta: { err: null }, transaction: { message: {
      accountKeys: [{ pubkey: noncanonical, signer: false, writable: true }],
    } } }; },
    async getProgramAccounts() { broadScans++; throw new Error("provider rejected wide scan"); },
  } as unknown as Connection;
  return { connection, accounts, batches, scans: () => broadScans };
}

test("PUMP without a bonding curve discovers noncanonical creator pool from bounded real mint activity", async () => {
  const fixture = chain();
  const selected = await discoverPumpSwapPool(fixture.connection, mint);
  expect(selected?.address.toBase58()).toBe(noncanonical.toBase58());
  expect(selected?.creator.toBase58()).toBe(creator.toBase58());
  expect(fixture.scans()).toBe(0);
  expect(Math.max(...fixture.batches)).toBeLessThanOrEqual(10);
  const inspected = await new PumpSwapVenue().inspectToken(fixture.connection, mint);
  expect(inspected?.pool).toBe(noncanonical.toBase58());
  expect(inspected?.quoteMint).toBe(WRAPPED_SOL_MINT.toBase58());
});
test("explicit PumpSwap registration verifies identities without unrelated indexed discovery", async () => {
  const f = chain(), core = Object.create(Solard.prototype) as Solard;
  core.connection = () => f.connection;
  Object.defineProperty(core, "venues", { value: { inspect: () => { throw new Error("Indexed requests require a personal token"); } } });
  Object.defineProperty(core, "tokens", { value: { upsert: (row: TokenRow) => row } });
  const row = await core.addToken(mint.toBase58(), undefined, { pool: noncanonical.toBase58(), venueHint: "pumpswap" });
  expect(row.quoteMint).toBe(WRAPPED_SOL_MINT.toBase58());
  expect(row.baseTokenProgram).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  f.connection.getSignaturesForAddress = async () => { throw new Error("Indexed requests require a personal token"); };
  const price = await quoteSolLoader(f.connection, () => {}, 0,
    quoteMint => quoteMint === mint.toBase58() ? row.pool : null)(mint.toBase58(), 6);
  expect(price).toBeGreaterThan(0);
  expect(f.scans()).toBe(0);
});

test("noncanonical pool rejects wrong owner, vault ownership or identity", async () => {
  const wrongOwner = chain();
  wrongOwner.accounts.get(noncanonical.toBase58())!.owner = PUMP_PROGRAM_ID;
  expect(await discoverPumpSwapPool(wrongOwner.connection, mint)).toBeNull();
  const wrongVault = chain();
  wrongVault.accounts.get(baseVault.toBase58())!.owner = TOKEN_PROGRAM_ID;
  expect(await discoverPumpSwapPool(wrongVault.connection, mint)).toBeNull();
});

test("positive noncanonical discovery reuses pool identity without rereading history", async () => {
  const fixture = chain();
  let signatureReads = 0;
  const original = fixture.connection.getSignaturesForAddress.bind(fixture.connection);
  fixture.connection.getSignaturesForAddress = async (...args: Parameters<Connection["getSignaturesForAddress"]>) => {
    signatureReads++;
    return original(...args);
  };
  expect((await discoverPumpSwapPool(fixture.connection, mint))?.address.equals(noncanonical)).toBe(true);
  expect((await discoverPumpSwapPool(fixture.connection, mint))?.address.equals(noncanonical)).toBe(true);
  expect(signatureReads).toBe(1);
});

test("provider 403 is surfaced, not misrepresented as an absent market", async () => {
  const fixture = chain();
  fixture.connection.getSignaturesForAddress = async () => {
    throw new Error("403 Forbidden: Request blocked (-32602)");
  };
  await expect(discoverPumpSwapPool(fixture.connection, mint)).rejects.toThrow("Request blocked");
});
