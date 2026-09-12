import { describe, expect, test } from "bun:test";
import {
  Keypair,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";

import {
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_ID,
} from "../venues/pump/constants.ts";
import {
  UnsupportedTokenAccountingSemanticsError,
  reduceTokenAccountTransaction,
} from "./token-account-reducer.ts";

const mint = Keypair.generate().publicKey.toBase58();
const alice = Keypair.generate().publicKey.toBase58();
const bob = Keypair.generate().publicKey.toBase58();
const carol = Keypair.generate().publicKey.toBase58();
const source = Keypair.generate().publicKey.toBase58();
const destination = Keypair.generate().publicKey.toBase58();

function parsed(
  programId: PublicKey,
  type: string,
  info: Record<string, unknown>,
) {
  return { programId, parsed: { type, info } } as any;
}

function tx(args: {
  pre: Array<{ address: string; owner: string; amount: bigint }>;
  post: Array<{ address: string; owner: string; amount: bigint }>;
  outer: any[];
  inner?: Array<{ index: number; instructions: any[] }>;
}): ParsedTransactionWithMeta {
  const addresses = [
    ...new Set([...args.pre, ...args.post].map((row) => row.address)),
  ];
  const keys = addresses.map((address) => ({
    pubkey: new PublicKey(address),
    signer: false,
    writable: true,
  }));
  const index = new Map(addresses.map((address, i) => [address, i]));
  return {
    slot: 10,
    blockTime: 1,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: args.pre.map((row) => ({
        accountIndex: index.get(row.address)!,
        mint,
        owner: row.owner,
        uiTokenAmount: {
          amount: row.amount.toString(),
          decimals: 6,
          uiAmount: null,
          uiAmountString: "0",
        },
      })),
      postTokenBalances: args.post.map((row) => ({
        accountIndex: index.get(row.address)!,
        mint,
        owner: row.owner,
        uiTokenAmount: {
          amount: row.amount.toString(),
          decimals: 6,
          uiAmount: null,
          uiAmountString: "0",
        },
      })),
      innerInstructions: args.inner ?? [],
      logMessages: [],
      rewards: [],
      loadedAddresses: { readonly: [], writable: [] },
      computeUnitsConsumed: 1,
    },
    transaction: {
      message: {
        accountKeys: keys,
        instructions: args.outer,
        recentBlockhash: "x",
      } as any,
      signatures: ["sig"],
    },
  } as ParsedTransactionWithMeta;
}

describe("token-account reducer", () => {
  test("executes CPI token effects in outer-instruction order", () => {
    const value = tx({
      pre: [
        { address: source, owner: alice, amount: 100n },
        { address: destination, owner: bob, amount: 0n },
      ],
      post: [
        { address: source, owner: carol, amount: 60n },
        { address: destination, owner: bob, amount: 40n },
      ],
      outer: [
        parsed(Keypair.generate().publicKey, "program", {}),
        parsed(SPL_TOKEN_PROGRAM_ID, "setAuthority", {
          account: source,
          authority: alice,
          authorityType: "accountOwner",
          newAuthority: carol,
        }),
      ],
      inner: [
        {
          index: 0,
          instructions: [
            parsed(SPL_TOKEN_PROGRAM_ID, "transferChecked", {
              source,
              destination,
              mint,
              authority: alice,
              tokenAmount: { amount: "40", decimals: 6 },
            }),
          ],
        },
      ],
    });
    const reduced = reduceTokenAccountTransaction({
      tx: value,
      signature: "sig",
      mint,
      decimals: 6,
      confidence: "finalized",
    });
    expect(reduced.events.map((event) => event.movement)).toEqual([
      "transfer",
      "change-owner",
    ]);
    expect(reduced.events[1]!.amountRaw).toBe(60n);
    expect(reduced.ownerBalancesAfter.get(carol)).toBe(60n);
    expect(reduced.ownerBalancesAfter.get(bob)).toBe(40n);
  });

  test("aggregates multiple token accounts above the owner reducer", () => {
    const second = Keypair.generate().publicKey.toBase58();
    const value = tx({
      pre: [
        { address: source, owner: alice, amount: 60n },
        { address: second, owner: alice, amount: 40n },
        { address: destination, owner: bob, amount: 0n },
      ],
      post: [
        { address: source, owner: alice, amount: 50n },
        { address: second, owner: alice, amount: 40n },
        { address: destination, owner: bob, amount: 10n },
      ],
      outer: [
        parsed(SPL_TOKEN_PROGRAM_ID, "transfer", {
          source,
          destination,
          authority: alice,
          amount: "10",
        }),
      ],
    });
    const reduced = reduceTokenAccountTransaction({
      tx: value,
      signature: "sig",
      mint,
      decimals: 6,
      confidence: "finalized",
    });
    expect(reduced.ownerBalancesBefore.get(alice)).toBe(100n);
    expect(reduced.ownerBalancesAfter.get(alice)).toBe(90n);
    expect(reduced.ownerBalancesAfter.get(bob)).toBe(10n);
  });

  test("fails strict replay on unsupported Token-2022 balance semantics", () => {
    const value = tx({
      pre: [{ address: source, owner: alice, amount: 100n }],
      post: [{ address: source, owner: alice, amount: 100n }],
      outer: [parsed(TOKEN_2022_ID, "syncNative", { account: source })],
    });
    expect(() =>
      reduceTokenAccountTransaction({
        tx: value,
        signature: "sig",
        mint,
        decimals: 6,
        confidence: "finalized",
      }),
    ).toThrow(UnsupportedTokenAccountingSemanticsError);
  });

  test("physical event ids do not depend on amount", () => {
    const build = (amount: bigint) =>
      tx({
        pre: [
          { address: source, owner: alice, amount: 100n },
          { address: destination, owner: bob, amount: 0n },
        ],
        post: [
          { address: source, owner: alice, amount: 100n - amount },
          { address: destination, owner: bob, amount },
        ],
        outer: [
          parsed(SPL_TOKEN_PROGRAM_ID, "transfer", {
            source,
            destination,
            authority: alice,
            amount: amount.toString(),
          }),
        ],
      });
    const first = reduceTokenAccountTransaction({
      tx: build(10n),
      signature: "sig",
      mint,
      decimals: 6,
      confidence: "finalized",
    });
    const secondResult = reduceTokenAccountTransaction({
      tx: build(20n),
      signature: "sig",
      mint,
      decimals: 6,
      confidence: "finalized",
    });
    expect(first.events[0]!.id).toBe(secondResult.events[0]!.id);
  });
});
