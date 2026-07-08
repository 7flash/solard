import { compactWallet, withSowl } from "../../../src/web/http.js";

function visibleTokenBalances(balanceResult: any): any[] {
  const rows = Array.isArray(balanceResult?.tokenBalances)
    ? balanceResult.tokenBalances
    : [];
  return rows
    .filter((row: any) => {
      try {
        return BigInt(String(row.amountRaw ?? "0")) > 0n;
      } catch {
        return false;
      }
    })
    .map((row: any) => ({
      mint: row.token?.mint ?? row.mint ?? null,
      symbol: row.token?.symbol ?? null,
      name: row.token?.name ?? null,
      amountRaw: String(row.amountRaw ?? "0"),
      amountUi: row.amountUi ?? null,
      decimals: row.decimals ?? row.token?.decimals ?? null,
    }));
}

export function GET(request: Request): Promise<Response> {
  return withSowl(request, async (sowl) => {
    const wallets = sowl.wallets.list().map(compactWallet);
    const tokens = sowl.tokens.list().slice(0, 250);
    const groups = sowl.groups.list().map((group) => ({
      ...group,
      wallets: sowl.groups.wallets(group.name),
    }));
    const executions = sowl.executions.history(100);

    const balanceTokens = tokens.slice(
      0,
      Number(process.env.SOLWAL_WEB_BALANCE_TOKEN_LIMIT ?? "100"),
    );
    const balances = await Promise.all(
      wallets.map(async (wallet) => {
        try {
          const row = await sowl.walletBalances(wallet.address, balanceTokens);
          return { ...row, visibleTokenBalances: visibleTokenBalances(row) };
        } catch (error) {
          return {
            wallet: { name: wallet.name, address: wallet.address },
            error: error instanceof Error ? error.message : String(error),
            visibleTokenBalances: [],
          };
        }
      }),
    );

    return { wallets, tokens, groups, executions, balances };
  });
}
