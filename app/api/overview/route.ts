import { compactWallet, withSowl } from "../../../src/web/http.js";

export function GET(request: Request): Promise<Response> {
  return withSowl(request, async (sowl) => {
    const wallets = sowl.wallets.list().map(compactWallet);
    const tokens = sowl.tokens.list().slice(0, 100);
    const groups = sowl.groups.list().map((group) => ({
      ...group,
      wallets: sowl.groups.wallets(group.name),
    }));
    const executions = sowl.executions.history(100);

    const balances = await Promise.all(
      wallets.map(async (wallet) => {
        try {
          return await sowl.walletBalances(wallet.address, tokens.slice(0, 25));
        } catch (error) {
          return {
            wallet: { name: wallet.name, address: wallet.address },
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    return { wallets, tokens, groups, executions, balances };
  });
}
