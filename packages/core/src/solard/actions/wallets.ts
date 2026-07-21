import { formatRaw } from "../../core/amounts.ts";
import { shortKey } from "../../core/log.ts";
import type { SolardActionContext } from "./context.ts";

export type WalletSummary = {
  id: number | null;
  name: string | null;
  address: string;
  isActive: number;
  createdAtMs: number | null;
  updatedAtMs: number | null;
};

export function compactWallet(row: {
  id?: number;
  name?: string | null;
  address: string | { toBase58(): string };
  isActive?: number;
  createdAtMs?: number;
  updatedAtMs?: number;
}): WalletSummary {
  return {
    id: row.id ?? null,
    name: row.name ?? null,
    address:
      typeof row.address === "string" ? row.address : row.address.toBase58(),
    isActive: row.isActive ?? 1,
    createdAtMs: row.createdAtMs ?? null,
    updatedAtMs: row.updatedAtMs ?? null,
  };
}

export function importWalletAction(
  ctx: SolardActionContext,
  input: {
    privateKey: string;
    name?: string | null;
    overwrite?: boolean | null;
  },
): WalletSummary {
  const privateKey = input.privateKey?.trim();
  if (!privateKey) throw new Error("privateKey is required");
  return compactWallet(
    ctx.slrd.importWallet(privateKey, input.name?.trim() || undefined, {
      overwrite: Boolean(input.overwrite),
    }),
  );
}

export async function listWalletsAction(
  ctx: SolardActionContext,
  input: { token?: string | null; showZero?: boolean } = {},
): Promise<
  Array<
    WalletSummary & {
      solLamports?: string;
      tokenBalances?: Array<Record<string, unknown>>;
    }
  >
> {
  const wallets = ctx.slrd.wallets.list();
  const selectedTokens = input.token
    ? [ctx.slrd.resolveToken(input.token)]
    : ctx.slrd.tokens.list();
  const rows = [] as Array<
    WalletSummary & {
      solLamports?: string;
      tokenBalances?: Array<Record<string, unknown>>;
    }
  >;
  for (const wallet of wallets) {
    const base = compactWallet(wallet);
    try {
      const balances = await ctx.slrd.walletBalances(wallet, selectedTokens);
      rows.push({
        ...base,
        solLamports: balances.solLamports.toString(),
        tokenBalances: balances.tokenBalances
          .filter(
            (balance) =>
              input.showZero || balance.amountRaw > 0n || Boolean(input.token),
          )
          .map((balance) => ({
            mint: balance.token.mint,
            name: balance.token.name ?? null,
            symbol: balance.token.symbol ?? null,
            amountRaw: balance.amountRaw.toString(),
            amountUi: formatRaw(balance.amountRaw, balance.decimals),
            decimals: balance.decimals,
            label: balance.token.symbol
              ? `$${balance.token.symbol}`
              : (balance.token.name ?? shortKey(balance.token.mint)),
          })),
      });
    } catch (error) {
      rows.push({
        ...base,
        tokenBalances: [],
        solLamports: undefined,
        balanceWarning: error instanceof Error ? error.message : String(error),
      } as WalletSummary & {
        solLamports?: string;
        tokenBalances?: Array<Record<string, unknown>>;
      });
    }
  }
  return rows;
}
