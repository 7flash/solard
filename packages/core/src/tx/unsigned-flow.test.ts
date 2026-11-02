import { expect, test } from "bun:test";
import { AddressLookupTableAccount, PublicKey, TransactionInstruction, type Connection } from "@solana/web3.js";
import { assembleTransaction } from "./assemble.ts";

const payer = new PublicKey(new Uint8Array(32).fill(21));
const pool = new PublicKey(new Uint8Array(32).fill(22));
const tableKey = new PublicKey(new Uint8Array(32).fill(23));
const keys = Array.from({ length: 44 }, (_, index) => new PublicKey(new Uint8Array(32).fill(40 + index)));
const table = new AddressLookupTableAccount({ key: tableKey, state: {
  deactivationSlot: 18446744073709551615n, lastExtendedSlot: 1,
  lastExtendedSlotStartIndex: 0, authority: payer, addresses: keys,
} });
const draft = {
  instructions: [new TransactionInstruction({ programId: pool,
    keys: keys.map(pubkey => ({ pubkey, isWritable: false, isSigner: false })),
    data: Buffer.from([1]),
  })],
  actions: [{ kind: "buy", meta: { pool: pool.toBase58(), fundingRoute: { legs: [] } } }],
  trackedAccounts: [], signers: [],
};
const blockhash = { get: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 10 }) } as any;

test("oversized unsigned route uses independently fetched active ALT and leaves signatures zero", async () => {
  let transactions = 0;
  const connection = {
    getSignaturesForAddress: async () => [{ signature: "history" }],
    _rpcRequest: async () => { transactions++; return { result: {
      version: 1, transaction: { message: { addressTableLookups: [{ accountKey: tableKey.toBase58() }] } },
    } }; },
    getAddressLookupTable: async (key: PublicKey) => ({ value: key.equals(tableKey) ? table : null }),
  } as unknown as Connection;
  const plan = await assembleTransaction({ connection, blockhash, payer, draft, altAddresses: [], unsigned: true });
  expect(transactions).toBeGreaterThan(0);
  expect(plan.lookupTables.map(item => item.key.toBase58())).toEqual([tableKey.toBase58()]);
  expect(plan.serializedSize).toBeLessThanOrEqual(1232);
  expect(plan.transaction.signatures.every(row => row.every(value => value === 0))).toBe(true);
  const historyReads = transactions;
  const again = await assembleTransaction({ connection, blockhash, payer, draft, altAddresses: [], unsigned: true });
  expect(transactions).toBe(historyReads);
  expect(again.lookupTables).toHaveLength(1);
  connection.getAddressLookupTable = async () => ({ context: { slot: 2 }, value: null });
  await expect(assembleTransaction({ connection, blockhash, payer, draft, altAddresses: [], unsigned: true }))
    .rejects.toMatchObject({ code: "TRANSACTION_TOO_LARGE" });

});

test("history provider error remains explicit packet-size rejection, without signing", async () => {
  const connection = { getSignaturesForAddress: async () => { throw new Error("RPC quota exhausted"); } } as unknown as Connection;
  await expect(assembleTransaction({ connection, blockhash, payer, draft, altAddresses: [], unsigned: true }))
    .rejects.toMatchObject({ code: "TRANSACTION_TOO_LARGE" });
});

test("sell exitRoute pool participates in existing ALT discovery", async () => {
  const seen: string[] = [];
  const connection = {
    getSignaturesForAddress: async (address: PublicKey) => { seen.push(address.toBase58()); return []; },
  } as unknown as Connection;
  const { discoverRouteLookupTables } = await import("./assemble.ts");
  await discoverRouteLookupTables(connection, { ...draft, actions: [{ kind: "sell", meta: {
    exitRoute: { legs: [{ pool: pool.toBase58() }] },
  } }] }, payer);
  expect(seen).toContain(pool.toBase58());
});

test("immediate fee recompilation reuses verified tables/blockhash without RPC and does not extend freshness", async () => {
  let reads = 0, hashes = 0;
  const connection = { getAddressLookupTable: async () => { reads++; return { value: table }; } } as unknown as Connection;
  const cache = { get: async () => { hashes++; return {blockhash: PublicKey.default.toBase58(),lastValidBlockHeight:10}; } } as any;
  const first = await assembleTransaction({connection,blockhash:cache,payer,draft,altAddresses:[tableKey],unsigned:true});
  const second = await assembleTransaction({connection,blockhash:cache,payer,draft:{...draft,cuPriceMicroLamports:5},altAddresses:[tableKey],unsigned:true,reusePlan:first});
  expect(reads).toBe(1); expect(hashes).toBe(1);
  expect(second.assembledAtMs).toBe(first.assembledAtMs);
  expect(second.recentBlockhash).toBe(first.recentBlockhash);
  expect(second.transaction.serialize()).not.toEqual(first.transaction.serialize());
  expect(second.draft.actions).toEqual(first.draft.actions);
  expect(second.serializedSize).toBeLessThanOrEqual(1232);
  await assembleTransaction({connection,blockhash:cache,payer,draft,altAddresses:[tableKey],unsigned:true,reusePlan:{...first,assembledAtMs:Date.now()-16000}});
  expect(reads).toBe(2); expect(hashes).toBe(2);
});
