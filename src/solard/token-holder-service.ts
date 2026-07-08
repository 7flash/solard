import { PublicKey, type Commitment } from "@solana/web3.js";
import type { Sowl } from "../index.js";
import { measureSolard, summarizeForMeasure } from "./api-response.js";

export type TokenHolder = {
  tokenAccount: string;
  owner: string | null;
  amount: string | null;
  uiAmount: string | null;
  decimals: number | null;
};

function short(value: string | null | undefined): string | null {
  return value
    ? value.length <= 14
      ? value
      : `${value.slice(0, 6)}…${value.slice(-6)}`
    : null;
}

function parseOwner(parsed: unknown): {
  owner: string | null;
  decimals: number | null;
} {
  const info =
    (parsed as any)?.value?.data?.parsed?.info ??
    (parsed as any)?.data?.parsed?.info;
  const tokenAmount = info?.tokenAmount;
  return {
    owner: typeof info?.owner === "string" ? info.owner : null,
    decimals:
      typeof tokenAmount?.decimals === "number" ? tokenAmount.decimals : null,
  };
}

export async function loadTokenHolders(
  sowl: Sowl,
  args: { mint: string; limit?: number; commitment?: Commitment },
): Promise<{ mint: string; holders: TokenHolder[] }> {
  const mint = args.mint.trim();
  if (!mint) throw new Error("mint is required");
  const limit = Math.max(1, Math.min(50, Number(args.limit ?? 12) || 12));
  const commitment = args.commitment ?? "confirmed";
  return (
    await measureSolard(
      "solard:token-holders",
      `load ${short(mint)}`,
      async () => {
        const connection = sowl.connection();
        const largest = await connection.getTokenLargestAccounts(
          new PublicKey(mint),
          commitment,
        );
        const accounts = largest.value.slice(0, limit);
        const holders = await Promise.all(
          accounts.map(async (account) => {
            let owner: string | null = null;
            let decimals: number | null = account.decimals ?? null;
            try {
              const parsed = await connection.getParsedAccountInfo(
                account.address,
                commitment,
              );
              const parsedOwner = parseOwner(parsed);
              owner = parsedOwner.owner;
              decimals = parsedOwner.decimals ?? decimals;
            } catch {
              // Largest account is still useful even if owner lookup misses.
            }
            return {
              tokenAccount: account.address.toBase58(),
              owner,
              amount: account.amount,
              uiAmount:
                account.uiAmountString ??
                (typeof account.uiAmount === "number"
                  ? String(account.uiAmount)
                  : null),
              decimals,
            };
          }),
        );
        return { mint, holders };
      },
      summarizeForMeasure,
    )
  ).value;
}
