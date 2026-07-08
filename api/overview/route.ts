import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { compactWallet, withSowl } from "../../../src/web/http.js";

type TokenBalanceRow = {
  mint: string;
  symbol: string | null;
  name: string | null;
  amountRaw: string;
  amountUi: string | null;
  decimals: number | null;
  tokenAccount: string;
  program: string;
};

type WalletBalanceRow = {
  wallet: { name: string | null; address: string };
  solLamports: string;
  visibleTokenBalances: TokenBalanceRow[];
  balanceWarning?: string | null;
};

function formatRaw(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const unit = 10n ** BigInt(decimals);
  const whole = value / unit;
  const frac = value % unit;
  const fracText = decimals === 0 ? "" : frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fracText ? `.${fracText}` : ""}`;
}

function tokenMetaByMint(tokens: any[]): Map<string, { symbol: string | null; name: string | null }> {
  const out = new Map<string, { symbol: string | null; name: string | null }>();
  for (const token of tokens) {
    if (!token?.mint) continue;
    out.set(String(token.mint), {
      symbol: typeof token.symbol === "string" && token.symbol ? token.symbol : null,
      name: typeof token.name === "string" && token.name ? token.name : null,
    });
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return out;
}

function parseTokenAccounts(value: Awaited<ReturnType<import("@solana/web3.js").Connection["getParsedTokenAccountsByOwner"]>, program: PublicKey, meta: Map<string, { symbol: string | null; name: string | null }>): TokenBalanceRow[] {
  const rows: TokenBalanceRow[] = [];
  for (const item of value.value ?? []) {
    const parsed = (item.account.data as any)?.parsed?.info;
    const mint = typeof parsed?.mint === "string" ? parsed.mint : null;
    const raw = typeof parsed?.tokenAmount?.amount === "string" ? parsed.tokenAmount.amount : null;
    if (!mint || raw == null) continue;
    let rawBig = 0n;
    try { rawBig = BigInt(raw); } catch { continue; }
    if (rawBig <= 0n) continue;
    const decimals = typeof parsed?.tokenAmount?.decimals === "number" ? parsed.tokenAmount.decimals : 0;
    const known = meta.get(mint);
    rows.push({
      mint,
      symbol: known?.symbol ?? null,
      name: known?.name ?? null,
      amountRaw: raw,
      amountUi: parsed?.tokenAmount?.uiAmountString ?? formatRaw(rawBig, decimals),
      decimals,
      tokenAccount: item.pubkey.toBase58(),
      program: program.toBase58(),
    });
  }
  return rows;
}

async function walletHoldings(args: {
  connection: import("@solana/web3.js").Connection;
  address: string;
  tokenMeta: Map<string, { symbol: string | null; name: string | null }>;
}): Promise<{ solLamports: string; visibleTokenBalances: TokenBalanceRow[]; balanceWarning?: string | null }> {
  const owner = new PublicKey(args.address);
  const warnings: string[] = [];

  let solLamports = "0";
  try {
    solLamports = String(await args.connection.getBalance(owner, "confirmed"));
  } catch (error) {
    warnings.push(`SOL balance unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const visibleTokenBalances: TokenBalanceRow[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const accounts = await args.connection.getParsedTokenAccountsByOwner(owner, { programId }, "confirmed");
      visibleTokenBalances.push(...parseTokenAccounts(accounts, programId, args.tokenMeta));
    } catch (error) {
      // Token account discovery is best-effort in the web overview. Never turn the whole dashboard red.
      warnings.push(`${programId.equals(TOKEN_PROGRAM_ID) ? "SPL" : "Token-2022"} holdings unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  visibleTokenBalances.sort((a, b) => {
    const as = a.symbol ?? a.name ?? a.mint;
    const bs = b.symbol ?? b.name ?? b.mint;
    return as.localeCompare(bs);
  });

  return { solLamports, visibleTokenBalances, balanceWarning: warnings.length ? warnings.join("; ") : null };
}

export function GET(request: Request): Promise<Response> {
  return withSowl(request, async (sowl) => {
    const wallets = sowl.wallets.list().map(compactWallet);
    const tokens = sowl.tokens.list().slice(0, 500);
    const groups = sowl.groups.list().map((group) => ({
      ...group,
      wallets: sowl.groups.wallets(group.name),
    }));
    const executions = sowl.executions.history(100);

    const tokenMeta = tokenMetaByMint(tokens);
    const concurrency = Math.max(1, Math.min(8, Number(process.env.SOLWAL_WEB_BALANCE_CONCURRENCY ?? "4")));
    const connection = sowl.connection();
    const balances = await mapLimit(wallets, concurrency, async (wallet): Promise<WalletBalanceRow> => {
      const row = await walletHoldings({ connection, address: wallet.address, tokenMeta });
      return { wallet: { name: wallet.name, address: wallet.address }, ...row };
    });

    return { wallets, tokens, groups, executions, balances };
  });
}
