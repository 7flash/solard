import { NATIVE_MINT } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  LAUNCHPAD_PROGRAM,
  getPdaLaunchpadPoolId,
} from "@raydium-io/raydium-sdk-v2";

import { readMint } from "../state.ts";
import { buildSparseTokenHistoryCandles1s } from "./candles.ts";
import { systemTokenHistoryClock } from "./clock.ts";
import { defaultTokenHistoryRepository } from "./repository.ts";
import { SolanaTokenHistoryRpc } from "./rpc.ts";
import { normalizeTokenHistoryRpcOptions } from "./service.ts";
import { parseRaydiumHistoryTransaction } from "./raydium-parser.ts";
import type {
  AddressHistoryCoverage,
  BackfillTokenHistoryOptions,
  TokenHistoryCoverage,
  TokenHistoryTrade,
} from "./types.ts";

const RAYDIUM_API = "https://api-v3.raydium.io";

type PoolRow = {
  id?: string;
  type?: string;
  programId?: string;
  tvl?: number;
  mint1?: { address?: string; symbol?: string };
  mint2?: { address?: string; symbol?: string };
};

export type RaydiumHistoryDiscovery = {
  mint: string;
  launchLabPool: string | null;
  pools: Array<{
    address: string;
    type: string | null;
    programId: string | null;
    tvl: number | null;
    quoteMint: string | null;
  }>;
  scanAddresses: string[];
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(`Raydium API ${response.status}: ${await response.text()}`);
  const json = await response.json();
  if (json?.success === false)
    throw new Error(`Raydium API: ${json?.msg ?? "request failed"}`);
  return json;
}

function quoteMint(row: PoolRow, mint: string): string | null {
  const a = row.mint1?.address ?? null;
  const b = row.mint2?.address ?? null;
  if (a === mint) return b;
  if (b === mint) return a;
  return null;
}

export async function discoverRaydiumHistory(
  connection: Connection,
  mintInput: string,
  options: { maxPools?: number } = {},
): Promise<RaydiumHistoryDiscovery> {
  const mint = new PublicKey(mintInput.trim());
  const mintText = mint.toBase58();
  const maxPools = Math.max(1, Math.min(32, Math.trunc(options.maxPools ?? 8)));
  const launchLabPool = getPdaLaunchpadPoolId(
    LAUNCHPAD_PROGRAM,
    mint,
    NATIVE_MINT,
  ).publicKey;
  const launchInfo = await connection
    .getAccountInfo(launchLabPool, "confirmed")
    .catch(() => null);

  const query = new URLSearchParams({
    mint1: mintText,
    poolType: "all",
    poolSortField: "liquidity",
    sortType: "desc",
    pageSize: String(Math.max(20, maxPools)),
    page: "1",
  });
  let rows: PoolRow[] = [];
  try {
    const response = await fetchJson(`${RAYDIUM_API}/pools/info/mint?${query}`);
    rows = Array.isArray(response?.data?.data) ? response.data.data : [];
  } catch (error) {
    if (!launchInfo)
      throw new Error(
        `Raydium discovery failed and no LaunchLab pool PDA exists: ${messageOf(error)}`,
      );
  }

  const pools = rows
    .filter((row) => typeof row.id === "string" && row.id)
    .slice(0, maxPools)
    .map((row) => ({
      address: row.id!,
      type: row.type ? String(row.type) : null,
      programId: row.programId ? String(row.programId) : null,
      tvl: Number.isFinite(Number(row.tvl)) ? Number(row.tvl) : null,
      quoteMint: quoteMint(row, mintText),
    }));
  const scanAddresses = [
    ...new Set([
      ...(launchInfo ? [launchLabPool.toBase58()] : []),
      ...pools.map((row) => row.address),
    ]),
  ];
  if (!scanAddresses.length)
    throw new Error(`No Raydium/LaunchLab market was found for ${mintText}`);
  return {
    mint: mintText,
    launchLabPool: launchInfo ? launchLabPool.toBase58() : null,
    pools,
    scanAddresses,
  };
}

function mergeSignatures(scans: Array<{ rows: any[] }>): any[] {
  const bySignature = new Map<string, any>();
  for (const scan of scans) {
    for (const row of scan.rows) {
      const previous = bySignature.get(row.signature);
      if (!previous || Number(row.slot) < Number(previous.slot))
        bySignature.set(row.signature, row);
    }
  }
  return [...bySignature.values()].sort(
    (a, b) =>
      Number(a.slot) - Number(b.slot) ||
      Number(a.blockTime ?? 0) - Number(b.blockTime ?? 0) ||
      String(a.signature).localeCompare(String(b.signature)),
  );
}

export async function backfillRaydiumTokenHistory(
  connection: Connection,
  mintInput: string,
  input: BackfillTokenHistoryOptions & { maxRaydiumPools?: number } = {},
): Promise<TokenHistoryCoverage> {
  const mint = new PublicKey(mintInput.trim());
  const mintText = mint.toBase58();
  const mintInfo = await readMint(connection, mint);
  const supplyUi = Number(mintInfo.supply) / 10 ** mintInfo.decimals;
  const discovery = await discoverRaydiumHistory(connection, mintText, {
    maxPools: input.maxRaydiumPools ?? 8,
  });
  const rpcOptions = normalizeTokenHistoryRpcOptions(input);
  const rpc = new SolanaTokenHistoryRpc(connection);

  if (input.replace) defaultTokenHistoryRepository.replaceTrades(mintText);

  const scans = [] as Array<{
    address: string;
    rows: any[];
    coverage: AddressHistoryCoverage;
  }>;
  for (const address of discovery.scanAddresses) {
    const scan = await rpc.scanAddress(
      "pool",
      new PublicKey(address),
      rpcOptions,
    );
    scans.push({ address, rows: scan.rows, coverage: scan.coverage });
  }
  const signatures = mergeSignatures(scans);
  const fetched = await rpc.fetchTransactions(signatures, rpcOptions);
  const parsedAtMs = systemTokenHistoryClock.nowMs();
  let skippedNoTimestamp = 0;
  let skippedAmbiguous = 0;
  const trades: TokenHistoryTrade[] = [];

  for (let order = 0; order < signatures.length; order += 1) {
    const scan = signatures[order]!;
    const tx = fetched.bySignature.get(scan.signature);
    if (!tx) continue;
    if (tx.blockTime == null) {
      skippedNoTimestamp += 1;
      continue;
    }
    const result = parseRaydiumHistoryTransaction({
      tx,
      signature: scan.signature,
      mint: mintText,
      decimals: mintInfo.decimals,
      supplyUi,
      historyOrder: order,
      scanAddress: scan.scanAddress,
      confidence: rpcOptions.commitment,
      updatedAtMs: parsedAtMs,
    });
    trades.push(...result.trades);
    skippedAmbiguous += result.ambiguous;
    if (
      order === 0 ||
      (order + 1) % 1000 === 0 ||
      order + 1 === signatures.length
    ) {
      input.onProgress?.({
        phase: "parse",
        completed: order + 1,
        total: signatures.length,
        trades: trades.length,
        ambiguous: skippedAmbiguous,
      });
    }
  }

  const persisted = defaultTokenHistoryRepository.persistTrades(
    trades,
    (progress) => input.onProgress?.({ phase: "store", ...progress }),
  );
  const allTrades = defaultTokenHistoryRepository.loadTrades(mintText);
  const candles = buildSparseTokenHistoryCandles1s(allTrades, parsedAtMs);
  defaultTokenHistoryRepository.replaceCandles1s(mintText);
  defaultTokenHistoryRepository.persistCandles1s(candles);
  input.onProgress?.({
    phase: "candles",
    trades: allTrades.length,
    candles: candles.length,
  });

  const launchScan = discovery.launchLabPool
    ? (scans.find((row) => row.address === discovery.launchLabPool) ?? null)
    : null;
  const primary = launchScan ?? scans[0]!;
  const allReachedStart = scans.every(
    (row) => row.coverage.reachedStart && !row.coverage.truncated,
  );
  const fromCreation = Boolean(
    launchScan?.coverage.reachedStart && !launchScan.coverage.truncated,
  );
  const creationSignature = fromCreation
    ? launchScan!.coverage.oldestSignature
    : null;
  const creationAtMs =
    fromCreation && launchScan!.coverage.oldestBlockTime != null
      ? launchScan!.coverage.oldestBlockTime! * 1000
      : null;
  const migratedPool = discovery.pools[0]?.address ?? null;

  const coverage: TokenHistoryCoverage = {
    version: 1,
    venueFamily: "raydium",
    mint: mintText,
    quoteMint: NATIVE_MINT.toBase58(),
    decimals: mintInfo.decimals,
    supplyRaw: mintInfo.supply.toString(),
    supplyUi,
    // Kept populated for backward compatibility with the v1 coverage shape.
    // For Raydium, this is the earliest primary history address, preferably LaunchLab.
    bondingCurve: primary.address,
    pool: migratedPool,
    commitment: rpcOptions.commitment,
    curve: primary.coverage,
    pumpswap: null,
    scanAddresses: scans.map((row) => row.coverage),
    launchLabPool: discovery.launchLabPool,
    raydiumPools: discovery.pools.map((row) => row.address),
    uniqueSignatures: signatures.length,
    parsedTransactions: fetched.bySignature.size,
    missingTransactions: fetched.missingTransactions,
    failedTransactions: fetched.failedTransactions,
    skippedNoTimestamp,
    skippedAmbiguous,
    storedTrades: defaultTokenHistoryRepository.countTrades(mintText),
    storedCandles1s: candles.length,
    insertedTrades: persisted.inserted,
    updatedTrades: persisted.updated,
    creationSignature,
    creationAtMs,
    creationSlot: fromCreation ? launchScan!.coverage.oldestSlot : null,
    creationName: null,
    creationSymbol: null,
    fromCreation,
    complete:
      fromCreation &&
      allReachedStart &&
      fetched.missingTransactions === 0 &&
      fetched.failedTransactions === 0 &&
      skippedNoTimestamp === 0,
    updatedAtMs: systemTokenHistoryClock.nowMs(),
  };
  defaultTokenHistoryRepository.saveCoverage(coverage);
  return coverage;
}
