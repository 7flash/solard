import { describe, expect, test } from "bun:test";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";

import type { TokenRow } from "../db/schema.ts";
import { SPL_TOKEN_PROGRAM_ID } from "../venues/pump/constants.ts";
import { historyTokenEvents } from "./token-event-history.ts";

function tokenAmount(amount: string) {
  return {
    amount,
    decimals: 6,
    uiAmount: null,
    uiAmountString: amount,
  };
}

function tx(args: {
  slot: number;
  signature: string;
  keys: string[];
  instructions: any[];
  pre?: any[];
  post?: any[];
  innerInstructions?: any[];
  loadedWritable?: string[];
  loadedReadonly?: string[];
  err?: unknown;
}): ParsedTransactionWithMeta {
  return {
    slot: args.slot,
    blockTime: args.slot,
    meta: {
      err: args.err ?? null,
      fee: 5_000,
      preBalances: args.keys.map(() => 0),
      postBalances: args.keys.map(() => 0),
      preTokenBalances: args.pre ?? [],
      postTokenBalances: args.post ?? [],
      innerInstructions: args.innerInstructions ?? [],
      logMessages: [],
      rewards: [],
      loadedAddresses: {
        readonly: (args.loadedReadonly ?? []).map(
          (address) => new PublicKey(address),
        ),
        writable: (args.loadedWritable ?? []).map(
          (address) => new PublicKey(address),
        ),
      },
      computeUnitsConsumed: 1,
    },
    transaction: {
      message: {
        accountKeys: args.keys.map((address) => ({
          pubkey: new PublicKey(address),
          signer: false,
          writable: true,
        })),
        instructions: args.instructions,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
      } as any,
      signatures: [args.signature],
    },
  } as ParsedTransactionWithMeta;
}

function signature(signature: string, slot: number) {
  return {
    signature,
    slot,
    err: null,
    memo: null,
    blockTime: slot,
    confirmationStatus: "finalized",
  };
}

describe("RPC exact token history", () => {
  test("discovers ordinary transfers through historical token-account addresses", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const accountA = Keypair.generate().publicKey.toBase58();
    const accountB = Keypair.generate().publicKey.toBase58();
    const ownerA = Keypair.generate().publicKey.toBase58();
    const ownerB = Keypair.generate().publicKey.toBase58();

    const initMint = tx({
      slot: 1,
      signature: "init-mint",
      keys: [mint],
      instructions: [
        {
          programId: SPL_TOKEN_PROGRAM_ID,
          parsed: { type: "initializeMint2", info: { mint } },
        },
      ],
    });
    const initA = tx({
      slot: 2,
      signature: "init-a",
      keys: [accountA, mint],
      instructions: [
        {
          programId: SPL_TOKEN_PROGRAM_ID,
          parsed: {
            type: "initializeAccount3",
            info: { account: accountA, mint, owner: ownerA },
          },
        },
        {
          programId: SPL_TOKEN_PROGRAM_ID,
          parsed: {
            type: "mintTo",
            info: {
              account: accountA,
              mint,
              authority: ownerA,
              amount: "100",
            },
          },
        },
      ],
      post: [
        {
          accountIndex: 0,
          mint,
          owner: ownerA,
          uiTokenAmount: tokenAmount("100"),
        },
      ],
    });
    const initB = tx({
      slot: 3,
      signature: "init-b",
      keys: [accountB, mint],
      instructions: [
        {
          programId: SPL_TOKEN_PROGRAM_ID,
          parsed: {
            type: "initializeAccount3",
            info: { account: accountB, mint, owner: ownerB },
          },
        },
      ],
      post: [
        {
          accountIndex: 0,
          mint,
          owner: ownerB,
          uiTokenAmount: tokenAmount("0"),
        },
      ],
    });
    const transfer = tx({
      slot: 4,
      signature: "plain-transfer",
      keys: [accountA, accountB],
      instructions: [
        {
          programId: SPL_TOKEN_PROGRAM_ID,
          parsed: {
            type: "transfer",
            info: {
              source: accountA,
              destination: accountB,
              authority: ownerA,
              amount: "25",
            },
          },
        },
      ],
      pre: [
        {
          accountIndex: 0,
          mint,
          owner: ownerA,
          uiTokenAmount: tokenAmount("100"),
        },
        {
          accountIndex: 1,
          mint,
          owner: ownerB,
          uiTokenAmount: tokenAmount("0"),
        },
      ],
      post: [
        {
          accountIndex: 0,
          mint,
          owner: ownerA,
          uiTokenAmount: tokenAmount("75"),
        },
        {
          accountIndex: 1,
          mint,
          owner: ownerB,
          uiTokenAmount: tokenAmount("25"),
        },
      ],
    });
    const transactions = new Map([
      ["init-mint", initMint],
      ["init-a", initA],
      ["init-b", initB],
      ["plain-transfer", transfer],
    ]);
    const addressRows = new Map([
      [
        mint,
        [
          signature("init-b", 3),
          signature("init-a", 2),
          signature("init-mint", 1),
        ],
      ],
      [accountA, [signature("plain-transfer", 4), signature("init-a", 2)]],
      [accountB, [signature("plain-transfer", 4), signature("init-b", 3)]],
    ]);
    const connection = {
      getSignaturesForAddress: async (
        address: PublicKey,
        options?: { before?: string },
      ) => {
        const rows = addressRows.get(address.toBase58()) ?? [];
        const start = options?.before
          ? Math.max(
              0,
              rows.findIndex((row) => row.signature === options.before) + 1,
            )
          : 0;
        return rows.slice(start);
      },
      getParsedTransactions: async (signatures: string[]) =>
        signatures.map((value) => transactions.get(value) ?? null),
      getBlock: async (slot: number) => ({
        signatures: [...transactions.entries()]
          .filter(([, value]) => value.slot === slot)
          .map(([key]) => key),
      }),
    } as unknown as Connection;
    const token = {
      mint,
      decimals: 6,
      baseTokenProgram: SPL_TOKEN_PROGRAM_ID.toBase58(),
    } as TokenRow;

    const history = await historyTokenEvents({
      connection,
      token,
      options: {
        provider: "rpc",
        exactOrdering: true,
        verifyCurrentBalances: false,
        commitment: "finalized",
      },
    });

    expect(history.coverage.status).toBe("complete");
    expect(history.coverage.fromCreation).toBe(true);
    expect(history.coverage.transferCoverage).toBe(
      "complete-token-account-index",
    );
    expect(
      history.events.some(
        (event) =>
          event.signature === "plain-transfer" &&
          event.movement === "transfer" &&
          event.amountRaw === 25n,
      ),
    ).toBe(true);
  });

  test("discovers CPI initialization and resolves loaded-address token balances", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const account = Keypair.generate().publicKey.toBase58();
    const owner = Keypair.generate().publicKey.toBase58();
    const payer = Keypair.generate().publicKey.toBase58();
    const system = "11111111111111111111111111111111";
    const outerProgram = Keypair.generate().publicKey;

    const initMint = tx({
      slot: 1,
      signature: "alt-init-mint",
      keys: [mint],
      instructions: [
        {
          programId: SPL_TOKEN_PROGRAM_ID,
          parsed: { type: "initializeMint2", info: { mint } },
        },
      ],
    });
    const initAccount = tx({
      slot: 2,
      signature: "cpi-init-account",
      keys: [mint, owner],
      loadedWritable: [account],
      instructions: [
        {
          programId: outerProgram,
          accounts: [new PublicKey(mint), new PublicKey(account)],
          data: "",
        },
      ],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programId: ASSOCIATED_TOKEN_PROGRAM_ID,
              accounts: [
                new PublicKey(payer),
                new PublicKey(account),
                new PublicKey(owner),
                new PublicKey(mint),
                new PublicKey(system),
                SPL_TOKEN_PROGRAM_ID,
              ],
              data: "",
            },
            {
              programId: SPL_TOKEN_PROGRAM_ID,
              parsed: {
                type: "initializeAccount3",
                info: { account, mint, owner },
              },
            },
            {
              programId: SPL_TOKEN_PROGRAM_ID,
              parsed: {
                type: "mintTo",
                info: { account, mint, authority: owner, amount: "10" },
              },
            },
          ],
        },
      ],
      post: [
        {
          accountIndex: 2,
          mint,
          owner,
          uiTokenAmount: tokenAmount("10"),
        },
      ],
    });
    const transactions = new Map([
      ["alt-init-mint", initMint],
      ["cpi-init-account", initAccount],
    ]);
    const addressRows = new Map([
      [mint, [signature("cpi-init-account", 2), signature("alt-init-mint", 1)]],
      [account, [signature("cpi-init-account", 2)]],
    ]);
    const connection = {
      getSignaturesForAddress: async (address: PublicKey) =>
        addressRows.get(address.toBase58()) ?? [],
      getParsedTransactions: async (signatures: string[]) =>
        signatures.map((value) => transactions.get(value) ?? null),
      getBlock: async (slot: number) => ({
        signatures: [...transactions.entries()]
          .filter(([, value]) => value.slot === slot)
          .map(([key]) => key),
      }),
    } as unknown as Connection;
    const token = {
      mint,
      decimals: 6,
      baseTokenProgram: SPL_TOKEN_PROGRAM_ID.toBase58(),
    } as TokenRow;

    const history = await historyTokenEvents({
      connection,
      token,
      options: {
        provider: "rpc",
        exactOrdering: true,
        verifyCurrentBalances: false,
        commitment: "finalized",
      },
    });

    expect(history.coverage.fromCreation).toBe(true);
    expect(history.coverage.parseErrors).toBe(0);
    expect(
      history.events.some(
        (event) =>
          event.signature === "cpi-init-account" &&
          event.movement === "mint" &&
          event.destinationOwner === owner &&
          event.amountRaw === 10n,
      ),
    ).toBe(true);
  });

  test("keeps multiple initialization incarnations for a reused token-account address", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const account = Keypair.generate().publicKey.toBase58();
    const owner = Keypair.generate().publicKey.toBase58();

    const initMint = tx({
      slot: 1,
      signature: "reinit-mint",
      keys: [mint],
      instructions: [
        {
          programId: SPL_TOKEN_PROGRAM_ID,
          parsed: { type: "initializeMint2", info: { mint } },
        },
      ],
    });
    const first = tx({
      slot: 2,
      signature: "reinit-first",
      keys: [account, mint],
      instructions: [
        {
          programId: SPL_TOKEN_PROGRAM_ID,
          parsed: {
            type: "initializeAccount3",
            info: { account, mint, owner },
          },
        },
        {
          programId: SPL_TOKEN_PROGRAM_ID,
          parsed: {
            type: "mintTo",
            info: { account, mint, authority: owner, amount: "100" },
          },
        },
      ],
      post: [
        {
          accountIndex: 0,
          mint,
          owner,
          uiTokenAmount: tokenAmount("100"),
        },
      ],
    });
    const close = tx({
      slot: 3,
      signature: "reinit-close",
      keys: [account, mint, owner],
      instructions: [
        {
          programId: SPL_TOKEN_PROGRAM_ID,
          parsed: {
            type: "burn",
            info: { account, mint, authority: owner, amount: "100" },
          },
        },
        {
          programId: SPL_TOKEN_PROGRAM_ID,
          parsed: {
            type: "closeAccount",
            info: { account, destination: owner, owner },
          },
        },
      ],
      pre: [
        {
          accountIndex: 0,
          mint,
          owner,
          uiTokenAmount: tokenAmount("100"),
        },
      ],
    });
    const second = tx({
      slot: 4,
      signature: "reinit-second",
      keys: [account, mint],
      instructions: [
        {
          programId: SPL_TOKEN_PROGRAM_ID,
          parsed: {
            type: "initializeAccount3",
            info: { account, mint, owner },
          },
        },
        {
          programId: SPL_TOKEN_PROGRAM_ID,
          parsed: {
            type: "mintTo",
            info: { account, mint, authority: owner, amount: "50" },
          },
        },
      ],
      post: [
        {
          accountIndex: 0,
          mint,
          owner,
          uiTokenAmount: tokenAmount("50"),
        },
      ],
    });
    const transactions = new Map([
      ["reinit-mint", initMint],
      ["reinit-first", first],
      ["reinit-close", close],
      ["reinit-second", second],
    ]);
    const addressRows = new Map([
      [
        mint,
        [
          signature("reinit-second", 4),
          signature("reinit-close", 3),
          signature("reinit-first", 2),
          signature("reinit-mint", 1),
        ],
      ],
      [
        account,
        [
          signature("reinit-second", 4),
          signature("reinit-close", 3),
          signature("reinit-first", 2),
        ],
      ],
    ]);
    const connection = {
      getSignaturesForAddress: async (address: PublicKey) =>
        addressRows.get(address.toBase58()) ?? [],
      getParsedTransactions: async (signatures: string[]) =>
        signatures.map((value) => transactions.get(value) ?? null),
      getBlock: async (slot: number) => ({
        signatures: [...transactions.entries()]
          .filter(([, value]) => value.slot === slot)
          .map(([key]) => key),
      }),
    } as unknown as Connection;
    const token = {
      mint,
      decimals: 6,
      baseTokenProgram: SPL_TOKEN_PROGRAM_ID.toBase58(),
    } as TokenRow;

    const history = await historyTokenEvents({
      connection,
      token,
      options: {
        provider: "rpc",
        exactOrdering: true,
        verifyCurrentBalances: false,
        commitment: "finalized",
      },
    });

    expect(history.coverage.fromCreation).toBe(true);
    expect(history.coverage.parseErrors).toBe(0);
    expect(
      history.events
        .filter((event) => event.movement === "mint")
        .map((event) => event.amountRaw),
    ).toEqual([100n, 50n]);
    expect(
      history.events.some(
        (event) => event.movement === "burn" && event.amountRaw === 100n,
      ),
    ).toBe(true);
  });

  test("keeps history partial when a required RPC transaction is unavailable", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const account = Keypair.generate().publicKey.toBase58();
    const owner = Keypair.generate().publicKey.toBase58();
    const initMint = tx({
      slot: 1,
      signature: "missing-mint",
      keys: [mint],
      instructions: [
        {
          programId: SPL_TOKEN_PROGRAM_ID,
          parsed: { type: "initializeMint2", info: { mint } },
        },
      ],
    });
    const initAccount = tx({
      slot: 2,
      signature: "missing-account",
      keys: [account, mint],
      instructions: [
        {
          programId: SPL_TOKEN_PROGRAM_ID,
          parsed: {
            type: "initializeAccount3",
            info: { account, mint, owner },
          },
        },
      ],
      post: [
        {
          accountIndex: 0,
          mint,
          owner,
          uiTokenAmount: tokenAmount("0"),
        },
      ],
    });
    const transactions = new Map([
      ["missing-mint", initMint],
      ["missing-account", initAccount],
    ]);
    const addressRows = new Map([
      [mint, [signature("missing-account", 2), signature("missing-mint", 1)]],
      [
        account,
        [signature("missing-transfer", 3), signature("missing-account", 2)],
      ],
    ]);
    const connection = {
      getSignaturesForAddress: async (address: PublicKey) =>
        addressRows.get(address.toBase58()) ?? [],
      getParsedTransactions: async (signatures: string[]) =>
        signatures.map((value) => transactions.get(value) ?? null),
      getBlock: async () => ({ signatures: [] }),
      getFirstAvailableBlock: async () => 1,
    } as unknown as Connection;
    const token = {
      mint,
      decimals: 6,
      baseTokenProgram: SPL_TOKEN_PROGRAM_ID.toBase58(),
    } as TokenRow;

    const history = await historyTokenEvents({
      connection,
      token,
      options: {
        provider: "rpc",
        exactOrdering: false,
        verifyCurrentBalances: false,
        commitment: "finalized",
      },
    });

    expect(history.coverage.status).toBe("partial");
    expect(history.coverage.fromCreation).toBe(false);
    expect(history.coverage.parseErrors).toBe(1);
  });
});
