import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { Solard } from "../sdk/slrd.ts";

export type SolardPortfolioOptions = {
  includeZero?: boolean;
  commitment?: "processed" | "confirmed" | "finalized";
  concurrency?: number;
};

export type SolardPortfolioRow = {
  kind: "sol" | "spl-token" | "token-2022";
  wallet: { name: string | null; address: string; groups: string[] };
  mint: string | null;
  tokenAccount: string | null;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  amountRaw: string;
  amountUi: string;
  program: string | null;
};

export type SolardPortfolio = {
  wallets: Array<{ name: string | null; address: string; groups: string[] }>;
  rows: SolardPortfolioRow[];
  totals: {
    wallets: number;
    tokenAccounts: number;
    holdings: number;
    solLamports: string | null;
  };
  loadedAtMs: number;
};

function groupNamesByWallet(slrd: Solard): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const group of slrd.groups.list()) {
    const name = String(group.name ?? "").trim();
    if (!name) continue;
    for (const member of slrd.groups.wallets(name)) {
      const address = String(
        (member as any).walletAddress ??
          (member as any).address ??
          member ??
          "",
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
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(limit, items.length || 1)) },
      async () => {
        while (next < items.length) {
          const index = next++;
          out[index] = await fn(items[index]!, index);
        }
      },
    ),
  );
  return out;
}

function formatRaw(rawText: string, decimals: number): string {
  const raw = BigInt(rawText || "0");
  if (decimals <= 0) return raw.toString();
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const frac = (raw % unit)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
}

function tokenIndex(
  slrd: Solard,
): Map<
  string,
  { name: string | null; symbol: string | null; decimals: number | null }
> {
  const out = new Map<
    string,
    { name: string | null; symbol: string | null; decimals: number | null }
  >();
  for (const token of slrd.tokens.list()) {
    out.set(String(token.mint).toLowerCase(), {
      name: token.name ?? null,
      symbol: token.symbol ?? null,
      decimals: typeof token.decimals === "number" ? token.decimals : null,
    });
  }
  return out;
}

async function tokenRowsForProgram(args: {
  connection: Connection;
  owner: PublicKey;
  wallet: { name: string | null; address: string; groups: string[] };
  programId: PublicKey;
  kind: "spl-token" | "token-2022";
  includeZero: boolean;
  tokenMeta: Map<
    string,
    { name: string | null; symbol: string | null; decimals: number | null }
  >;
  commitment: "processed" | "confirmed" | "finalized";
}): Promise<SolardPortfolioRow[]> {
  const accounts = await args.connection.getParsedTokenAccountsByOwner(
    args.owner,
    { programId: args.programId },
    args.commitment,
  );
  const rows: SolardPortfolioRow[] = [];
  for (const account of accounts.value) {
    const info = (account.account.data as any)?.parsed?.info;
    const amount = info?.tokenAmount;
    const mint = String(info?.mint ?? "");
    const raw = String(amount?.amount ?? "0");
    if (!args.includeZero && raw === "0") continue;
    const decimals = Number.isInteger(amount?.decimals)
      ? Number(amount.decimals)
      : (args.tokenMeta.get(mint.toLowerCase())?.decimals ?? 0);
    const meta = args.tokenMeta.get(mint.toLowerCase());
    rows.push({
      kind: args.kind,
      wallet: args.wallet,
      mint,
      tokenAccount: account.pubkey.toBase58(),
      name: meta?.name ?? null,
      symbol: meta?.symbol ?? null,
      decimals,
      amountRaw: raw,
      amountUi: String(amount?.uiAmountString ?? formatRaw(raw, decimals)),
      program: args.programId.toBase58(),
    });
  }
  return rows;
}

export async function loadSolardPortfolio(
  slrd: Solard,
  options: SolardPortfolioOptions = {},
): Promise<SolardPortfolio> {
  const includeZero = options.includeZero === true;
  const commitment = options.commitment ?? "confirmed";
  const groups = groupNamesByWallet(slrd);
  const wallets = slrd.wallets.list().map((wallet) => ({
    name: wallet.name ?? null,
    address: wallet.address,
    groups: groups.get(String(wallet.address).toLowerCase()) ?? [],
  }));
  const tokenMeta = tokenIndex(slrd);
  const connection = slrd.connection();
  let solTotal = 0n;
  const concurrency = Math.max(
    1,
    Math.min(
      8,
      options.concurrency ??
        Number(process.env.SOLARD_PORTFOLIO_CONCURRENCY ?? "4"),
    ),
  );

  const nested = await mapLimit(wallets, concurrency, async (wallet) => {
    const owner = new PublicKey(wallet.address);
    const sol = await connection
      .getBalance(owner, commitment)
      .catch(() => null);
    const rows: SolardPortfolioRow[] = [];
    if (sol != null) {
      solTotal += BigInt(sol);
      rows.push({
        kind: "sol",
        wallet,
        mint: null,
        tokenAccount: null,
        name: "Solana",
        symbol: "SOL",
        decimals: 9,
        amountRaw: String(sol),
        amountUi: formatRaw(String(sol), 9),
        program: null,
      });
    }
    const [spl, token2022] = await Promise.all([
      tokenRowsForProgram({
        connection,
        owner,
        wallet,
        programId: TOKEN_PROGRAM_ID,
        kind: "spl-token",
        includeZero,
        tokenMeta,
        commitment,
      }).catch(() => []),
      tokenRowsForProgram({
        connection,
        owner,
        wallet,
        programId: TOKEN_2022_PROGRAM_ID,
        kind: "token-2022",
        includeZero,
        tokenMeta,
        commitment,
      }).catch(() => []),
    ]);
    rows.push(...spl, ...token2022);
    return rows;
  });
  const rows = nested
    .flat()
    .sort((a, b) =>
      `${a.wallet.name ?? a.wallet.address}:${a.symbol ?? a.mint ?? ""}`.localeCompare(
        `${b.wallet.name ?? b.wallet.address}:${b.symbol ?? b.mint ?? ""}`,
      ),
    );
  return {
    wallets,
    rows,
    totals: {
      wallets: wallets.length,
      tokenAccounts: rows.filter((row) => row.kind !== "sol").length,
      holdings: rows.filter(
        (row) => row.kind !== "sol" && row.amountRaw !== "0",
      ).length,
      solLamports: String(solTotal),
    },
    loadedAtMs: Date.now(),
  };
}
