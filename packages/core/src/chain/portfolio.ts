import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, type Commitment, type Connection } from "@solana/web3.js";

import type { Solard } from "../core/solard.ts";

export type WalletTokenHolding = {
  mint: string;
  tokenAccount: string;
  program: "spl-token" | "token-2022";
  programId: string;
  amountRaw: bigint;
  amountUi: string;
  decimals: number;
  name: string | null;
  symbol: string | null;
};

export type WalletAssetPortfolioRow = {
  walletName: string;
  walletAddress: string;
  solLamports: bigint;
  tokenHoldings: WalletTokenHolding[];
  tokenScanComplete: boolean;
  tokenScanErrors: string[];
};

export type WalletAssetPortfolio = {
  rows: WalletAssetPortfolioRow[];
  totalSolLamports: bigint;
  tokenHoldingCount: number;
  distinctTokenCount: number;
  tokenScanErrorCount: number;
  tokenTotals: Array<{
    mint: string;
    name: string | null;
    symbol: string | null;
    decimals: number;
    amountRaw: bigint;
    amountUi: string;
  }>;
};

export type WalletAssetPortfolioOptions = {
  walletRefs?: string[];
  includeZero?: boolean;
  commitment?: Commitment;
  concurrency?: number;
  requestDelayMs?: number;
};

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function canonicalTokenLabel(
  mint: string,
): { name: string; symbol: string } | null {
  if (mint === NATIVE_MINT.toBase58()) {
    return { name: "Wrapped SOL", symbol: "WSOL" };
  }
  if (mint === USDC_MINT) {
    return { name: "USD Coin", symbol: "USDC" };
  }
  return null;
}

function formatRaw(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const fraction = (raw % unit)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

const pause = (ms: number) =>
  ms > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        out[index] = await fn(items[index]!, index);
      }
    }),
  );
  return out;
}

function tokenMetaIndex(slrd: Solard) {
  const out = new Map<
    string,
    { name: string | null; symbol: string | null; decimals: number | null }
  >();
  // Read-only lookup only. This intentionally never refreshes/upserts tokens.
  for (const token of slrd.tokens.list()) {
    out.set(String(token.mint).toLowerCase(), {
      name: token.name ?? null,
      symbol: token.symbol ?? null,
      decimals: typeof token.decimals === "number" ? token.decimals : null,
    });
  }
  return out;
}

async function holdingsForProgram(args: {
  connection: Connection;
  owner: PublicKey;
  programId: PublicKey;
  program: "spl-token" | "token-2022";
  includeZero: boolean;
  commitment: Commitment;
  tokenMeta: ReturnType<typeof tokenMetaIndex>;
}): Promise<WalletTokenHolding[]> {
  const response = await args.connection.getParsedTokenAccountsByOwner(
    args.owner,
    { programId: args.programId },
    args.commitment,
  );

  const rows: WalletTokenHolding[] = [];
  for (const account of response.value) {
    const info = (account.account.data as any)?.parsed?.info;
    const tokenAmount = info?.tokenAmount;
    const mint = String(info?.mint ?? "").trim();
    const rawText = String(tokenAmount?.amount ?? "0");
    if (!mint || !/^\d+$/.test(rawText)) continue;

    const amountRaw = BigInt(rawText);
    if (!args.includeZero && amountRaw === 0n) continue;

    const meta = args.tokenMeta.get(mint.toLowerCase());
    const canonical = canonicalTokenLabel(mint);
    const decimals = Number.isInteger(tokenAmount?.decimals)
      ? Number(tokenAmount.decimals)
      : (meta?.decimals ?? 0);

    rows.push({
      mint,
      tokenAccount: account.pubkey.toBase58(),
      program: args.program,
      programId: args.programId.toBase58(),
      amountRaw,
      amountUi: String(
        tokenAmount?.uiAmountString ?? formatRaw(amountRaw, decimals),
      ),
      decimals,
      // Canonical well-known mint identity wins over stale local aliases.
      name: canonical?.name ?? meta?.name ?? null,
      symbol: canonical?.symbol ?? meta?.symbol ?? null,
    });
  }
  return rows;
}

export async function loadWalletAssetPortfolio(
  slrd: Solard,
  options: WalletAssetPortfolioOptions = {},
): Promise<WalletAssetPortfolio> {
  const includeZero = options.includeZero === true;
  const commitment = options.commitment ?? "confirmed";
  const concurrency = Math.max(
    1,
    Math.min(
      8,
      Math.trunc(
        options.concurrency ??
          Number(process.env.SOLARD_PORTFOLIO_CONCURRENCY ?? "1"),
      ),
    ),
  );
  const requestDelayMs = Math.max(
    0,
    Math.trunc(
      options.requestDelayMs ??
        Number(process.env.SOLARD_PORTFOLIO_RPC_DELAY_MS ?? "75"),
    ),
  );

  const allWallets = slrd.wallets.list();
  const selectedAddresses = options.walletRefs?.length
    ? new Set(
        options.walletRefs.map((ref) =>
          slrd.resolveWallet(ref).address.toBase58(),
        ),
      )
    : null;
  const wallets = selectedAddresses
    ? allWallets.filter((wallet) => selectedAddresses.has(wallet.address))
    : allWallets;

  const balances = new Map<string, bigint>();
  const connection = slrd.connection();

  // Native SOL is batched: <=100 accounts per RPC request.
  for (let offset = 0; offset < wallets.length; offset += 100) {
    const batch = wallets.slice(offset, offset + 100);
    const infos = await connection.getMultipleAccountsInfo(
      batch.map((wallet) => new PublicKey(wallet.address)),
      commitment,
    );
    for (let index = 0; index < batch.length; index += 1) {
      balances.set(batch[index]!.address, BigInt(infos[index]?.lamports ?? 0));
    }
    if (offset + 100 < wallets.length) await pause(requestDelayMs);
  }

  const tokenMeta = tokenMetaIndex(slrd);

  const rows = await mapLimit(wallets, concurrency, async (wallet) => {
    const owner = new PublicKey(wallet.address);
    const tokenHoldings: WalletTokenHolding[] = [];
    const tokenScanErrors: string[] = [];

    // Sequential per wallet on purpose. Two simultaneous getTokenAccounts calls
    // can still trip restrictive public RPC rate limits.
    for (const spec of [
      {
        programId: TOKEN_PROGRAM_ID,
        program: "spl-token" as const,
      },
      {
        programId: TOKEN_2022_PROGRAM_ID,
        program: "token-2022" as const,
      },
    ]) {
      try {
        tokenHoldings.push(
          ...(await holdingsForProgram({
            connection,
            owner,
            programId: spec.programId,
            program: spec.program,
            includeZero,
            commitment,
            tokenMeta,
          })),
        );
      } catch (error) {
        tokenScanErrors.push(
          `${spec.program}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await pause(requestDelayMs);
    }

    tokenHoldings.sort((left, right) => {
      const a = left.symbol ?? left.name ?? left.mint;
      const b = right.symbol ?? right.name ?? right.mint;
      return a.localeCompare(b);
    });

    return {
      walletName: wallet.name,
      walletAddress: wallet.address,
      solLamports: balances.get(wallet.address) ?? 0n,
      tokenHoldings,
      tokenScanComplete: tokenScanErrors.length === 0,
      tokenScanErrors,
    };
  });

  rows.sort((left, right) =>
    left.solLamports === right.solLamports
      ? left.walletName.localeCompare(right.walletName)
      : left.solLamports > right.solLamports
        ? -1
        : 1,
  );

  const totals = new Map<
    string,
    {
      mint: string;
      name: string | null;
      symbol: string | null;
      decimals: number;
      amountRaw: bigint;
    }
  >();

  for (const row of rows) {
    for (const holding of row.tokenHoldings) {
      if (holding.amountRaw === 0n) continue;
      const existing = totals.get(holding.mint);
      if (existing) {
        existing.amountRaw += holding.amountRaw;
      } else {
        totals.set(holding.mint, {
          mint: holding.mint,
          name: holding.name,
          symbol: holding.symbol,
          decimals: holding.decimals,
          amountRaw: holding.amountRaw,
        });
      }
    }
  }

  const tokenTotals = [...totals.values()]
    .map((row) => ({
      ...row,
      amountUi: formatRaw(row.amountRaw, row.decimals),
    }))
    .sort((left, right) =>
      (left.symbol ?? left.name ?? left.mint).localeCompare(
        right.symbol ?? right.name ?? right.mint,
      ),
    );

  return {
    rows,
    totalSolLamports: rows.reduce((sum, row) => sum + row.solLamports, 0n),
    tokenHoldingCount: rows.reduce(
      (sum, row) =>
        sum +
        row.tokenHoldings.filter((holding) => holding.amountRaw > 0n).length,
      0,
    ),
    distinctTokenCount: tokenTotals.length,
    tokenScanErrorCount: rows.reduce(
      (sum, row) => sum + row.tokenScanErrors.length,
      0,
    ),
    tokenTotals,
  };
}
