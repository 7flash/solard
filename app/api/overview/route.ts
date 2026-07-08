import { PublicKey, type Connection } from "@solana/web3.js";
import { compactWallet, withSowl } from "../../../src/web/http.js";

type WalletBalanceRow = {
  wallet: { name: string | null; address: string; groups: string[] };
  solLamports: string | null;
  visibleTokenBalances: never[];
  balanceWarning?: string | null;
};

function groupNamesByWallet(groups: any[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const group of groups) {
    const name = String(group?.name ?? "").trim();
    if (!name) continue;
    for (const member of group?.wallets ?? []) {
      const address = String(
        member?.walletAddress ?? member?.address ?? member ?? "",
      ).trim();
      if (!address) continue;
      const key = address.toLowerCase();
      const rows = out.get(key) ?? [];
      if (!rows.includes(name)) rows.push(name);
      out.set(key, rows);
    }
  }
  return out;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, Math.max(1, items.length))) },
    async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

async function solBalance(
  connection: Connection | null,
  address: string,
): Promise<{ solLamports: string | null; balanceWarning?: string | null }> {
  if (!connection)
    return { solLamports: null, balanceWarning: "RPC not configured" };
  try {
    const owner = new PublicKey(address);
    return {
      solLamports: String(await connection.getBalance(owner, "confirmed")),
    };
  } catch (error) {
    return {
      solLamports: null,
      balanceWarning: error instanceof Error ? error.message : String(error),
    };
  }
}

export function GET(request: Request): Promise<Response> {
  return withSowl(request, async (sowl) => {
    const url = new URL(request.url);
    const fast =
      url.searchParams.get("fast") === "1" ||
      url.searchParams.get("fast") === "true";
    const includeBalances =
      !fast && url.searchParams.get("balances") !== "none";

    const rawGroups = sowl.groups
      .list()
      .map((group) => ({ ...group, wallets: sowl.groups.wallets(group.name) }));
    const walletGroups = groupNamesByWallet(rawGroups);
    const wallets = sowl.wallets.list().map((wallet) => {
      const compact = compactWallet(wallet);
      return {
        ...compact,
        groups: walletGroups.get(String(compact.address).toLowerCase()) ?? [],
      };
    });
    const tokens = sowl.tokens.list().slice(0, 500);
    const executions = sowl.executions.history(100);

    let connection: Connection | null = null;
    if (includeBalances) {
      try {
        connection = sowl.connection();
      } catch {
        connection = null;
      }
    }

    const concurrency = Math.max(
      1,
      Math.min(
        8,
        Number(process.env.SOLARD_WEB_SOL_BALANCE_CONCURRENCY ?? "6"),
      ),
    );
    const balances: WalletBalanceRow[] = includeBalances
      ? await mapLimit(wallets, concurrency, async (wallet) => {
          const row = await solBalance(connection, wallet.address);
          return {
            wallet: {
              name: wallet.name,
              address: wallet.address,
              groups: wallet.groups ?? [],
            },
            visibleTokenBalances: [],
            ...row,
          };
        })
      : wallets.map((wallet) => ({
          wallet: {
            name: wallet.name,
            address: wallet.address,
            groups: wallet.groups ?? [],
          },
          solLamports: null,
          visibleTokenBalances: [],
          balanceWarning: "SOL balance not refreshed yet",
        }));

    return {
      wallets,
      tokens,
      groups: rawGroups,
      executions,
      balances,
      meta: { fast, includeBalances, holdings: "portfolio-page-only" },
    };
  });
}
