import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  Keypair,
  PublicKey,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";

import { closeDatabase, openDatabase } from "../db/database.ts";
import type { TokenRow } from "../db/schema.ts";
import { SPL_TOKEN_PROGRAM_ID } from "../venues/pump/constants.ts";
import { historyTokenEvents } from "./token-event-history.ts";
import { createRawTransactionCachingConnection } from "./raw-transaction-cache.ts";

function transaction(args: {
  mint: string;
  source: string;
  destination: string;
  sourceOwner: string;
  destinationOwner: string;
}): ParsedTransactionWithMeta {
  const addresses = [args.source, args.destination];
  return {
    slot: 10,
    blockTime: 100,
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [0, 0],
      postBalances: [0, 0],
      preTokenBalances: [
        {
          accountIndex: 0,
          mint: args.mint,
          owner: args.sourceOwner,
          uiTokenAmount: {
            amount: "100",
            decimals: 6,
            uiAmount: null,
            uiAmountString: "0.0001",
          },
        },
        {
          accountIndex: 1,
          mint: args.mint,
          owner: args.destinationOwner,
          uiTokenAmount: {
            amount: "0",
            decimals: 6,
            uiAmount: null,
            uiAmountString: "0",
          },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 0,
          mint: args.mint,
          owner: args.sourceOwner,
          uiTokenAmount: {
            amount: "75",
            decimals: 6,
            uiAmount: null,
            uiAmountString: "0.000075",
          },
        },
        {
          accountIndex: 1,
          mint: args.mint,
          owner: args.destinationOwner,
          uiTokenAmount: {
            amount: "25",
            decimals: 6,
            uiAmount: null,
            uiAmountString: "0.000025",
          },
        },
      ],
      innerInstructions: [],
      logMessages: [],
      rewards: [],
      loadedAddresses: { readonly: [], writable: [] },
      computeUnitsConsumed: 1,
    },
    transaction: {
      message: {
        accountKeys: addresses.map((address) => ({
          pubkey: new PublicKey(address),
          signer: false,
          writable: true,
        })),
        instructions: [
          {
            programId: SPL_TOKEN_PROGRAM_ID,
            parsed: {
              type: "transferChecked",
              info: {
                source: args.source,
                destination: args.destination,
                mint: args.mint,
                authority: args.sourceOwner,
                tokenAmount: { amount: "25", decimals: 6 },
              },
            },
          },
        ],
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
      } as any,
      signatures: ["signature-1"],
    },
  } as ParsedTransactionWithMeta;
}

describe("raw transaction cache", () => {
  test("rebuilds parser output with networking disabled", async () => {
    const path = join(
      tmpdir(),
      `solard-raw-cache-${process.pid}-${Date.now()}-${Math.random()}.sqlite`,
    );
    const database = openDatabase(path);
    const mint = Keypair.generate().publicKey.toBase58();
    const source = Keypair.generate().publicKey.toBase58();
    const destination = Keypair.generate().publicKey.toBase58();
    const sourceOwner = Keypair.generate().publicKey.toBase58();
    const destinationOwner = Keypair.generate().publicKey.toBase58();
    const tx = transaction({
      mint,
      source,
      destination,
      sourceOwner,
      destinationOwner,
    });
    let onlineCalls = 0;
    const online = {
      getSignaturesForAddress: async () => {
        onlineCalls += 1;
        return [
          {
            signature: "signature-1",
            slot: 10,
            err: null,
            memo: null,
            blockTime: 100,
            confirmationStatus: "finalized",
          },
        ];
      },
      getParsedTransactions: async () => {
        onlineCalls += 1;
        return [tx];
      },
      getBlock: async () => {
        onlineCalls += 1;
        return { signatures: ["signature-1"] };
      },
    } as unknown as Connection;
    const token = {
      mint,
      decimals: 6,
      baseTokenProgram: SPL_TOKEN_PROGRAM_ID.toBase58(),
    } as TokenRow;
    try {
      const cachedOnline = createRawTransactionCachingConnection({
        connection: online,
        database,
        network: true,
      });
      const first = await historyTokenEvents({
        connection: cachedOnline,
        token,
        options: {
          provider: "rpc",
          fromSlot: 10,
          toSlot: 10,
          exactOrdering: true,
          verifyCurrentBalances: false,
          commitment: "finalized",
        },
      });
      expect(first.events).toHaveLength(1);
      expect(onlineCalls).toBeGreaterThan(0);

      let forbiddenCalls = 0;
      const offlineTarget = new Proxy(
        {},
        {
          get() {
            return async () => {
              forbiddenCalls += 1;
              throw new Error("network disabled");
            };
          },
        },
      ) as Connection;
      const offline = createRawTransactionCachingConnection({
        connection: offlineTarget,
        database,
        network: false,
      });
      const rebuilt = await historyTokenEvents({
        connection: offline,
        token,
        options: {
          provider: "rpc",
          fromSlot: 10,
          toSlot: 10,
          exactOrdering: true,
          verifyCurrentBalances: false,
          commitment: "finalized",
        },
      });
      expect(forbiddenCalls).toBe(0);
      expect(rebuilt.events).toHaveLength(1);
      expect(rebuilt.events[0]!.id).toBe(first.events[0]!.id);
      expect(rebuilt.events[0]!.amountRaw).toBe(25n);
      expect(rebuilt.coverage.ordering).toBe("transaction");
    } finally {
      closeDatabase(path);
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    }
  });
});
