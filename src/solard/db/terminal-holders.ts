import { dbMeasure, summarizeForMeasure } from "../measure.js";
import {
  initTerminalStore,
  terminalDb,
  upsertProcessStatus,
  type TerminalToken,
} from "../../../shared/db.js";

export type TerminalHolderRow = {
  mint: string;
  rank: number;
  tokenAccount: string;
  owner: string | null;
  amountRaw: string;
  amountUi: number;
  decimals: number;
  pctSupply: number | null;
  source: string;
  updatedAtMs: number;
};

export type TerminalHolderSnapshot = {
  mint: string;
  supplyRaw: string;
  supplyUi: number;
  decimals: number;
  holderCount: number;
  top1Pct: number | null;
  top3Pct: number | null;
  top5Pct: number | null;
  top10Pct: number | null;
  source: string;
  updatedAtMs: number;
  error: string | null;
};

export type TerminalHolderCandidate = Pick<
  TerminalToken,
  | "mint"
  | "symbol"
  | "name"
  | "image"
  | "source"
  | "updatedAtMs"
  | "marketCapUsd"
>;

let holderTablesReady = false;

function ensureHolderTables(): void {
  if (holderTablesReady) return;
  initTerminalStore();
  terminalDb.exec(`CREATE TABLE IF NOT EXISTS terminalHolderSnapshotsLive (
    mint TEXT PRIMARY KEY,
    supplyRaw TEXT NOT NULL DEFAULT '0',
    supplyUi REAL NOT NULL DEFAULT 0,
    decimals INTEGER NOT NULL DEFAULT 0,
    holderCount INTEGER NOT NULL DEFAULT 0,
    top1Pct REAL,
    top3Pct REAL,
    top5Pct REAL,
    top10Pct REAL,
    source TEXT NOT NULL DEFAULT 'rpc',
    updatedAtMs INTEGER NOT NULL DEFAULT 0,
    error TEXT
  )`);
  terminalDb.exec(`CREATE TABLE IF NOT EXISTS terminalHoldersLive (
    mint TEXT NOT NULL,
    rank INTEGER NOT NULL,
    tokenAccount TEXT NOT NULL,
    owner TEXT,
    amountRaw TEXT NOT NULL DEFAULT '0',
    amountUi REAL NOT NULL DEFAULT 0,
    decimals INTEGER NOT NULL DEFAULT 0,
    pctSupply REAL,
    source TEXT NOT NULL DEFAULT 'rpc',
    updatedAtMs INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (mint, rank)
  )`);
  terminalDb.exec(
    "CREATE INDEX IF NOT EXISTS idx_terminal_holders_mint_updated ON terminalHoldersLive(mint, updatedAtMs DESC)",
  );
  terminalDb.exec(
    "CREATE INDEX IF NOT EXISTS idx_terminal_holders_owner ON terminalHoldersLive(owner)",
  );
  terminalDb.exec(
    "CREATE INDEX IF NOT EXISTS idx_terminal_holder_snapshot_updated ON terminalHolderSnapshotsLive(updatedAtMs DESC)",
  );
  holderTablesReady = true;
}

function rpcUrl(): string {
  const explicit =
    process.env.HELIUS_RPC_URL?.trim() ||
    process.env.RPC_ENDPOINT?.trim() ||
    process.env.SOLANA_RPC_URL?.trim();
  if (explicit) return explicit;
  const key = process.env.HELIUS_API_KEY?.trim();
  if (key)
    return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  return "https://api.mainnet-beta.solana.com";
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(
      Number(process.env.SOLARD_HOLDERS_RPC_TIMEOUT_MS ?? "7000"),
    ),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `solard-holders:${method}:${Date.now()}`,
      method,
      params,
    }),
  });
  if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`);
  const payload = (await response.json()) as {
    result?: T;
    error?: { message?: string; code?: number };
  };
  if (payload.error)
    throw new Error(
      payload.error.message ||
        `RPC ${method} ${payload.error.code ?? "failed"}`,
    );
  return payload.result as T;
}

function pctRaw(
  amountRaw: string | null | undefined,
  supplyRaw: string | null | undefined,
): number | null {
  try {
    const amount = BigInt(amountRaw || "0");
    const supply = BigInt(supplyRaw || "0");
    if (supply <= 0n) return null;
    return Number((amount * 1_000_000n) / supply) / 10_000;
  } catch {
    const amount = Number(amountRaw ?? 0);
    const supply = Number(supplyRaw ?? 0);
    return Number.isFinite(amount) && Number.isFinite(supply) && supply > 0
      ? (amount / supply) * 100
      : null;
  }
}

function sumPct(
  rows: Array<{ pctSupply: number | null }>,
  count: number,
): number | null {
  const values = rows
    .slice(0, count)
    .map((row) => row.pctSupply)
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
  return values.length
    ? Math.round(values.reduce((sum, value) => sum + value, 0) * 10_000) /
        10_000
    : null;
}

function amountUiFrom(
  raw: string,
  decimals: number,
  uiAmount?: number | null,
  uiAmountString?: string | null,
): number {
  const supplied =
    uiAmountString != null
      ? Number(uiAmountString)
      : uiAmount != null
        ? Number(uiAmount)
        : Number.NaN;
  if (Number.isFinite(supplied)) return supplied;
  const base = Number(raw);
  return Number.isFinite(base) ? base / 10 ** Math.max(0, decimals) : 0;
}

function ownerFromAccount(account: any): string | null {
  return (
    account?.data?.parsed?.info?.owner ??
    account?.data?.parsed?.info?.account?.owner ??
    null
  );
}

function validMint(mint: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint);
}

export function listTerminalHolderCandidates(
  args: {
    limit?: number;
    activeWindowMs?: number;
    source?: string | null;
  } = {},
): TerminalHolderCandidate[] {
  ensureHolderTables();
  const limit = Math.max(1, Math.min(Number(args.limit ?? 40), 250));
  const activeWindowMs = Math.max(
    0,
    Number(
      args.activeWindowMs ??
        process.env.SOLARD_HOLDER_ACTIVE_WINDOW_MS ??
        "1200000",
    ),
  );
  const minUpdatedAt = activeWindowMs > 0 ? Date.now() - activeWindowMs : 0;
  const source = String(args.source ?? "").toLowerCase();
  const sourceClause =
    !source || source.includes("both")
      ? "1=1"
      : source.includes("helius")
        ? "LOWER(source) LIKE '%helius%' OR LOWER(source) LIKE '%curve%'"
        : "LOWER(source) LIKE '%pumpportal%' OR LOWER(source) LIKE '%curve%'";
  return terminalDb
    .raw<TerminalHolderCandidate>(
      `SELECT mint, symbol, name, image, source, updatedAtMs, marketCapUsd
     FROM terminalTokensLive
     WHERE updatedAtMs >= ?
       AND ${sourceClause}
       AND mint IS NOT NULL
     ORDER BY updatedAtMs DESC
     LIMIT ?`,
      minUpdatedAt,
      limit,
    )
    .filter((row) => validMint(row.mint));
}

export function getCachedTokenHolders(
  mint: string,
  limit = 20,
): {
  ok: boolean;
  mint: string;
  supply: TerminalHolderSnapshot | null;
  holders: TerminalHolderRow[];
  distribution: Record<string, number | null>;
  stale: boolean;
  unavailableReason?: string;
} {
  ensureHolderTables();
  const rows = terminalDb.raw<TerminalHolderRow>(
    "SELECT * FROM terminalHoldersLive WHERE mint = ? ORDER BY rank ASC LIMIT ?",
    mint,
    Math.max(1, Math.min(limit, 50)),
  );
  const supply =
    terminalDb.raw<TerminalHolderSnapshot>(
      "SELECT * FROM terminalHolderSnapshotsLive WHERE mint = ? LIMIT 1",
      mint,
    )[0] ?? null;
  const staleMs = Number(process.env.SOLARD_HOLDER_STALE_MS ?? "30000");
  const stale =
    !supply?.updatedAtMs || Date.now() - Number(supply.updatedAtMs) > staleMs;
  return {
    ok: !!supply && !supply.error,
    mint,
    supply,
    holders: rows,
    distribution: {
      top1Pct: supply?.top1Pct ?? null,
      top3Pct: supply?.top3Pct ?? null,
      top5Pct: supply?.top5Pct ?? null,
      top10Pct: supply?.top10Pct ?? null,
    },
    stale,
    ...(supply?.error ? { unavailableReason: supply.error } : {}),
  };
}

export async function refreshTokenHolders(
  mint: string,
  args: { limit?: number; source?: string } = {},
): Promise<ReturnType<typeof getCachedTokenHolders>> {
  ensureHolderTables();
  const cleanMint = String(mint ?? "").trim();
  const limit = Math.max(
    1,
    Math.min(Number(args.limit ?? process.env.SOLARD_HOLDER_LIMIT ?? "20"), 50),
  );
  if (!validMint(cleanMint)) {
    return {
      ok: false,
      mint: cleanMint,
      supply: null,
      holders: [],
      distribution: {
        top1Pct: null,
        top3Pct: null,
        top5Pct: null,
        top10Pct: null,
      },
      stale: true,
      unavailableReason: "invalid token mint",
    };
  }
  return await dbMeasure.measure(
    {
      start: () => "refresh token holders",
      end: (result) => ({ result: summarizeForMeasure(result) }),
      catch: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        terminalDb.exec(
          `INSERT INTO terminalHolderSnapshotsLive (mint, source, updatedAtMs, error)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(mint) DO UPDATE SET source=excluded.source, updatedAtMs=excluded.updatedAtMs, error=excluded.error`,
          cleanMint,
          args.source ?? "rpc",
          Date.now(),
          message,
        );
        upsertProcessStatus({
          name: "solard-holder-snapshots",
          kind: "snapshot",
          status: "error",
          error,
          data: { mint: cleanMint, phase: "refresh-token-holders" },
        });
        return getCachedTokenHolders(cleanMint, limit);
      },
    },
    async () => {
      const [largest, supply] = await Promise.all([
        rpc<{
          value: Array<{
            address: string;
            amount: string;
            decimals: number;
            uiAmount?: number | null;
            uiAmountString?: string | null;
          }>;
        }>("getTokenLargestAccounts", [cleanMint, { commitment: "confirmed" }]),
        rpc<{
          value: {
            amount: string;
            decimals: number;
            uiAmount?: number | null;
            uiAmountString?: string | null;
          };
        }>("getTokenSupply", [cleanMint, { commitment: "confirmed" }]),
      ]);
      const accounts = (largest.value ?? []).slice(0, limit);
      const ownerRows = accounts.length
        ? await rpc<{ value: any[] }>("getMultipleAccounts", [
            accounts.map((row) => row.address),
            { commitment: "confirmed", encoding: "jsonParsed" },
          ]).catch(() => ({ value: [] }))
        : { value: [] };
      const now = Date.now();
      const holders = accounts.map((row, index): TerminalHolderRow => {
        const decimals = Number.isFinite(row.decimals)
          ? row.decimals
          : (supply.value?.decimals ?? 6);
        return {
          mint: cleanMint,
          rank: index + 1,
          tokenAccount: row.address,
          owner: ownerFromAccount(ownerRows.value?.[index]),
          amountRaw: String(row.amount ?? "0"),
          amountUi: amountUiFrom(
            String(row.amount ?? "0"),
            decimals,
            row.uiAmount,
            row.uiAmountString,
          ),
          decimals,
          pctSupply: pctRaw(String(row.amount ?? "0"), supply.value?.amount),
          source: args.source ?? "rpc:getTokenLargestAccounts",
          updatedAtMs: now,
        };
      });
      const supplyUi = amountUiFrom(
        String(supply.value?.amount ?? "0"),
        Number(supply.value?.decimals ?? 6),
        supply.value?.uiAmount,
        supply.value?.uiAmountString,
      );
      terminalDb.exec(
        "DELETE FROM terminalHoldersLive WHERE mint = ?",
        cleanMint,
      );
      for (const holder of holders) {
        terminalDb.exec(
          `INSERT INTO terminalHoldersLive
            (mint, rank, tokenAccount, owner, amountRaw, amountUi, decimals, pctSupply, source, updatedAtMs)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          holder.mint,
          holder.rank,
          holder.tokenAccount,
          holder.owner,
          holder.amountRaw,
          holder.amountUi,
          holder.decimals,
          holder.pctSupply,
          holder.source,
          holder.updatedAtMs,
        );
      }
      terminalDb.exec(
        `INSERT INTO terminalHolderSnapshotsLive
          (mint, supplyRaw, supplyUi, decimals, holderCount, top1Pct, top3Pct, top5Pct, top10Pct, source, updatedAtMs, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(mint) DO UPDATE SET
           supplyRaw=excluded.supplyRaw,
           supplyUi=excluded.supplyUi,
           decimals=excluded.decimals,
           holderCount=excluded.holderCount,
           top1Pct=excluded.top1Pct,
           top3Pct=excluded.top3Pct,
           top5Pct=excluded.top5Pct,
           top10Pct=excluded.top10Pct,
           source=excluded.source,
           updatedAtMs=excluded.updatedAtMs,
           error=NULL`,
        cleanMint,
        String(supply.value?.amount ?? "0"),
        supplyUi,
        Number(supply.value?.decimals ?? 6),
        holders.length,
        sumPct(holders, 1),
        sumPct(holders, 3),
        sumPct(holders, 5),
        sumPct(holders, 10),
        args.source ?? "rpc:getTokenLargestAccounts",
        now,
      );
      upsertProcessStatus({
        name: "solard-holder-snapshots",
        kind: "snapshot",
        status: "ok",
        data: {
          mint: cleanMint,
          holders: holders.length,
          top10Pct: sumPct(holders, 10),
        },
      });
      return getCachedTokenHolders(cleanMint, limit);
    },
  );
}

export async function getOrRefreshTokenHolders(
  mint: string,
  args: { limit?: number; refresh?: boolean; source?: string } = {},
): Promise<ReturnType<typeof getCachedTokenHolders>> {
  const cached = getCachedTokenHolders(mint, args.limit ?? 20);
  if (!args.refresh && !cached.stale && cached.holders.length) return cached;
  return await refreshTokenHolders(mint, args);
}

export async function refreshRecentHolderSnapshots(
  args: { limit?: number; source?: string | null } = {},
): Promise<{
  checked: number;
  refreshed: number;
  errors: number;
}> {
  ensureHolderTables();
  const candidates = listTerminalHolderCandidates({
    limit:
      args.limit ??
      Number(process.env.SOLARD_HOLDER_SNAPSHOT_CANDIDATES ?? "20"),
    source: args.source,
  });
  const result = { checked: candidates.length, refreshed: 0, errors: 0 };
  for (const candidate of candidates) {
    try {
      await refreshTokenHolders(candidate.mint, {
        limit: Number(process.env.SOLARD_HOLDER_LIMIT ?? "20"),
        source: candidate.source || "worker",
      });
      result.refreshed++;
      await Bun.sleep(
        Number(process.env.SOLARD_HOLDER_RPC_SPACING_MS ?? "120"),
      );
    } catch (error) {
      result.errors++;
      upsertProcessStatus({
        name: "solard-holder-snapshots",
        kind: "snapshot",
        status: "candidate-error",
        error,
        data: { mint: candidate.mint },
      });
    }
  }
  return result;
}
