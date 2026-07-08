import { PublicKey, type Connection } from "@solana/web3.js";
import type { Sowl } from "../sdk/sowl.js";

export type SolardOverviewOptions = {
  fast?: boolean;
  includeBalances?: boolean;
  balanceKind?: "none" | "sol";
  tokenLimit?: number;
  executionLimit?: number;
  solBalanceConcurrency?: number;
};

export type SolardOverviewWallet = {
  name: string | null;
  address: string;
  groups: string[];
};

export type SolardWalletBalanceRow = {
  wallet: SolardOverviewWallet;
  solLamports: string | null;
  visibleTokenBalances: never[];
  balanceWarning?: string | null;
};

export type SolardOverview = {
  wallets: SolardOverviewWallet[];
  tokens: unknown[];
  groups: unknown[];
  executions: unknown[];
  balances: SolardWalletBalanceRow[];
  meta: {
    fast: boolean;
    includeBalances: boolean;
    holdings: "portfolio-page-only";
    loadedAtMs: number;
  };
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

function compactWallet(wallet: any): { name: string | null; address: string } {
  return {
    name: wallet?.name ?? null,
    address: String(
      wallet?.address ?? wallet?.publicKey ?? wallet?.pubkey ?? "",
    ),
  };
}

export async function loadSolardOverview(
  sowl: Sowl,
  options: SolardOverviewOptions = {},
): Promise<SolardOverview> {
  const fast = options.fast === true;
  const includeBalances =
    options.includeBalances === true && !fast && options.balanceKind !== "none";
  const tokenLimit = Math.max(0, Math.min(10_000, options.tokenLimit ?? 500));
  const executionLimit = Math.max(
    0,
    Math.min(5_000, options.executionLimit ?? 100),
  );

  const rawGroups = sowl.groups
    .list()
    .map((group: any) => ({
      ...group,
      wallets: sowl.groups.wallets(group.name),
    }));
  const walletGroups = groupNamesByWallet(rawGroups);
  const wallets = sowl.wallets
    .list()
    .map((wallet: any) => {
      const compact = compactWallet(wallet);
      return {
        ...compact,
        groups: walletGroups.get(String(compact.address).toLowerCase()) ?? [],
      };
    })
    .filter((wallet) => wallet.address);

  const tokens = sowl.tokens.list().slice(0, tokenLimit);
  const executions = sowl.executions.history(executionLimit);

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
      options.solBalanceConcurrency ??
        Number(process.env.SOLARD_WEB_SOL_BALANCE_CONCURRENCY ?? "6"),
    ),
  );
  const balances: SolardWalletBalanceRow[] = includeBalances
    ? await mapLimit(wallets, concurrency, async (wallet) => {
        const row = await solBalance(connection, wallet.address);
        return { wallet, visibleTokenBalances: [], ...row };
      })
    : wallets.map((wallet) => ({
        wallet,
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
    meta: {
      fast,
      includeBalances,
      holdings: "portfolio-page-only",
      loadedAtMs: Date.now(),
    },
  };
}
