import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";

import { loadWalletAssetPortfolio } from "./portfolio.ts";

const MAIN = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
const WORKER = new PublicKey(new Uint8Array(32).fill(2)).toBase58();

function solard() {
  const wallets = [
    { name: "main", address: MAIN },
    { name: "worker", address: WORKER },
  ];
  return {
    wallets: { list: () => wallets },
    tokens: { list: () => [] },
    resolveWallet(ref: string) {
      const clean = ref.replace(/^@/, "");
      const wallet = wallets.find(
        (row) => row.name === clean || row.address === clean,
      );
      if (!wallet) throw new Error(`Unknown wallet: ${ref}`);
      return { address: new PublicKey(wallet.address) };
    },
    connection() {
      return {
        async getMultipleAccountsInfo(keys: PublicKey[]) {
          return keys.map(() => ({ lamports: 1_000_000_000 }));
        },
        async getParsedTokenAccountsByOwner() {
          return { value: [] };
        },
      };
    },
  } as any;
}

describe("wallet portfolio exclusion", () => {
  test("excludes a wallet from the default all-wallet scan", async () => {
    const portfolio = await loadWalletAssetPortfolio(solard(), {
      excludeWalletRefs: ["main"],
      requestDelayMs: 0,
    });

    expect(portfolio.rows.map((row) => row.walletName)).toEqual(["worker"]);
  });

  test("exclusion wins over an explicit inclusion list", async () => {
    const portfolio = await loadWalletAssetPortfolio(solard(), {
      walletRefs: ["main", "worker"],
      excludeWalletRefs: ["@main"],
      requestDelayMs: 0,
    });

    expect(portfolio.rows.map((row) => row.walletName)).toEqual(["worker"]);
  });

  test("can exclude every selected wallet without falling back to all wallets", async () => {
    const portfolio = await loadWalletAssetPortfolio(solard(), {
      walletRefs: ["main"],
      excludeWalletRefs: ["main"],
      requestDelayMs: 0,
    });

    expect(portfolio.rows).toEqual([]);
    expect(portfolio.tokenHoldingCount).toBe(0);
  });
});
