import { expect, test } from "bun:test";
import {
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import { walletLedger, walletLedgerEntry } from "./wallet-ledger.ts";
import { HELIUS_TIP_ACCOUNTS } from "../tx/helius-landing.ts";
import { PUMP_PROGRAM_ID } from "../venues/pump/constants.ts";

const wallet = new PublicKey("11111111111111111111111111111111");
const ata = new PublicKey("So11111111111111111111111111111111111111112");
const other = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
function fixture(keys = [wallet, ata, other]): any {
  return {
    slot: 10,
    blockTime: 100,
    transaction: {
      signatures: ["sig"],
      message: {
        accountKeys: keys.map((pubkey) => ({ pubkey })),
        instructions: [],
      },
    },
    meta: {
      fee: 5000,
      err: null,
      preBalances: [10000000, 0, 0],
      postBalances: [9995000, 0, 0],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
      logMessages: [],
    },
  };
}
function parsed(programId: PublicKey, type: string, info: object) {
  return { programId, parsed: { type, info } };
}
function token(accountIndex: number, mint: string, raw: string) {
  return {
    accountIndex,
    mint,
    owner: wallet.toBase58(),
    uiTokenAmount: { amount: raw, decimals: 9 },
  };
}

test("failed transaction charges only actual payer fee, never attempted tips or transfers", () => {
  const tx = fixture([wallet, new PublicKey(HELIUS_TIP_ACCOUNTS[0])]);
  tx.meta.err = { InstructionError: [0, { Custom: 6042 }] };
  tx.transaction.message.instructions = [
    parsed(SystemProgram.programId, "transfer", {
      source: wallet.toBase58(),
      destination: HELIUS_TIP_ACCOUNTS[0],
      lamports: 5000,
    }),
  ];
  const entry = walletLedgerEntry(tx, wallet);
  expect(entry.classifications).toEqual(["failed-fee"]);
  expect(entry.tipLamports).toBe(0n);
  expect(entry.networkFeeLamports).toBe(5000n);
  expect(entry.solDeltaLamports).toBe(-5000n);
  expect(entry.components.residual).toBe(0n);
});

test("tip, token-account rent, priority and arbitrary token raw deltas reconcile without double fees", () => {
  const tx = fixture([wallet, ata, new PublicKey(HELIUS_TIP_ACCOUNTS[0])]);
  tx.meta.postBalances = [10000000 - 2000000 - 5000 - 5002, 2000000, 5000];
  tx.meta.fee = 5002;
  tx.meta.postTokenBalances = [
    token(1, other.toBase58(), "900719925474099312345"),
  ];
  const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 10000 });
  const price = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 200,
  });
  tx.transaction.message.instructions = [
    { programId: limit.programId, data: bs58.encode(limit.data) },
    { programId: price.programId, data: bs58.encode(price.data) },
    parsed(SystemProgram.programId, "createAccount", {
      source: wallet.toBase58(),
      newAccount: ata.toBase58(),
      lamports: 2000000,
    }),
    parsed(SystemProgram.programId, "transfer", {
      source: wallet.toBase58(),
      destination: HELIUS_TIP_ACCOUNTS[0],
      lamports: 5000,
    }),
  ];
  const entry = walletLedgerEntry(tx, wallet);
  expect(entry.priorityFeeLamports).toBe(2n);
  expect(entry.networkFeeLamports).toBe(5002n);
  expect(entry.tokenDeltas[0]!.deltaRaw).toBe(900719925474099312345n);
  expect(entry.components.tokenAccountRent).toBe(-2000000n);
  expect(entry.components.residual).toBe(0n);
});

test("WSOL wrapping keeps principal distinct from reserve rent and unwrap refunds both correctly", () => {
  const opened = fixture();
  opened.meta.postBalances = [6995000, 3000000, 0];
  opened.meta.postTokenBalances = [token(1, NATIVE_MINT.toBase58(), "1000000")];
  opened.transaction.message.instructions = [
    parsed(SystemProgram.programId, "createAccount", {
      source: wallet.toBase58(),
      newAccount: ata.toBase58(),
      lamports: 2000000,
    }),
    parsed(SystemProgram.programId, "transfer", {
      source: wallet.toBase58(),
      destination: ata.toBase58(),
      lamports: 1000000,
    }),
  ];
  const first = walletLedgerEntry(opened, wallet);
  expect(first.components.tokenAccountRent).toBe(-2000000n);
  expect(first.components.wrapUnwrap).toBe(-1000000n);
  expect(first.economicSolDeltaLamports).toBe(-2005000n);
  expect(first.components.residual).toBe(0n);
  const closed = fixture();
  closed.meta.preBalances = [10000000, 3000000, 0];
  closed.meta.postBalances = [12995000, 0, 0];
  closed.meta.preTokenBalances = [token(1, NATIVE_MINT.toBase58(), "1000000")];
  closed.transaction.message.instructions = [
    parsed(TOKEN_PROGRAM_ID, "closeAccount", {
      account: ata.toBase58(),
      destination: wallet.toBase58(),
    }),
  ];
  const second = walletLedgerEntry(closed, wallet);
  expect(second.components.tokenAccountRent).toBe(2000000n);
  expect(second.components.wrapUnwrap).toBe(1000000n);
  expect(second.components.residual).toBe(0n);
});

test("unknown movements remain residual; missing CU limit makes nonzero priority unknown", () => {
  const tx = fixture();
  tx.meta.postBalances[0] -= 2000;
  const price = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 200,
  });
  tx.transaction.message.instructions = [
    { programId: price.programId, data: bs58.encode(price.data) },
  ];
  const entry = walletLedgerEntry(tx, wallet);
  expect(entry.components.residual).toBe(-2000n);
  expect(entry.priorityFeeLamports).toBeNull();
});

test("decoded venue instruction provenance separates trade principal and creator claims from external transfers", () => {
  const buy = fixture();
  buy.meta.postBalances[0] -= 1000;
  buy.transaction.message.instructions = [
    { programId: PUMP_PROGRAM_ID, data: "1" },
  ];
  buy.meta.logMessages = [
    `Program ${PUMP_PROGRAM_ID} invoke [1]`,
    "Program log: Instruction: Buy",
    `Program ${PUMP_PROGRAM_ID} success`,
  ];
  buy.meta.innerInstructions = [
    {
      index: 0,
      instructions: [
        parsed(SystemProgram.programId, "transfer", {
          source: wallet.toBase58(),
          destination: other.toBase58(),
          lamports: 1000,
        }),
      ],
    },
  ];
  const traded = walletLedgerEntry(buy, wallet);
  expect(traded.venues).toEqual(["pump-curve"]);
  expect(traded.tradeSide).toBe("buy");
  expect(traded.components.tradePrincipal).toBe(-1000n);
  expect(traded.components.transfers).toBe(0n);
  expect(traded.components.residual).toBe(0n);
  const claimed = fixture();
  claimed.meta.postBalances[0] += 1000;
  claimed.transaction.message.instructions = [
    { programId: PUMP_PROGRAM_ID, data: "1" },
  ];
  claimed.meta.logMessages = [
    `Program ${PUMP_PROGRAM_ID} invoke [1]`,
    "Program log: Instruction: CollectCreatorFee",
    `Program ${PUMP_PROGRAM_ID} success`,
  ];
  claimed.meta.innerInstructions = [
    {
      index: 0,
      instructions: [
        parsed(SystemProgram.programId, "transfer", {
          source: other.toBase58(),
          destination: wallet.toBase58(),
          lamports: 1000,
        }),
      ],
    },
  ];
  const result = walletLedgerEntry(claimed, wallet);
  expect(result.components.claims).toBe(1000n);
  expect(result.components.residual).toBe(0n);
});

test("wallet history discovers incoming account-only transfers and reports missing/closed-account coverage", async () => {
  const incoming = fixture([other, ata, wallet]);
  incoming.meta.preBalances = [10000000, 2000000, 1000];
  incoming.meta.postBalances = [9995000, 2000000, 1000];
  incoming.meta.preTokenBalances = [token(1, other.toBase58(), "0")];
  incoming.meta.postTokenBalances = [
    token(1, other.toBase58(), "12345678901234567890"),
  ];
  const connection = {
    getParsedTokenAccountsByOwner: async () => ({ value: [{ pubkey: ata }] }),
    getSignaturesForAddress: async (address: PublicKey) =>
      address.equals(ata)
        ? [
            { signature: "incoming", slot: 10, blockTime: 100 },
            { signature: "missing", slot: 9, blockTime: 99 },
          ]
        : [],
    getParsedTransactions: async (ids: string[]) =>
      ids.map((id) => (id === "incoming" ? incoming : null)),
  } as any;
  const result = await walletLedger(connection, wallet, {
    since: "1970-01-01T00:01:30.000Z",
  });
  expect(result.entries[0]!.networkFeeLamports).toBe(0n);
  expect(result.entries[0]!.tokenDeltas[0]!.deltaRaw).toBe(
    12345678901234567890n,
  );
  expect(result.coverage.status).toBe("partial");
  expect(result.coverage.missingTransactions).toEqual(["missing"]);
  expect(result.coverage.historyQueryComplete).toBe(false);
});
