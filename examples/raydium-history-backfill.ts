#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { NATIVE_MINT } from "@solana/spl-token";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { createMeasure } from "measure-fn";
import { createTraderSolard } from "@solard/sdk";

type Flags = Map<string, string>;
type Trade = {
  signature: string;
  slot: number;
  blockTime: number;
  tradedAtMs: number;
  owner: string;
  side: "buy" | "sell";
  tokenDeltaRaw: string;
  tokenDeltaUi: number;
  solDeltaUi: number;
  priceSol: number;
  pool: string;
  source: "raydium";
};
const WSOL = NATIVE_MINT.toBase58();
const m = createMeasure("raydium-history");

function parseArgs(argv: string[]): Flags {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (!v.startsWith("--")) continue;
    const [k, x] = v.slice(2).split("=", 2);
    if (x != null) out.set(k!, x);
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--"))
      out.set(k!, argv[++i]!);
    else out.set(k!, "true");
  }
  return out;
}
function flag(f: Flags, k: string) {
  const v = f.get(k);
  return v && v !== "true" ? v : undefined;
}
function required(f: Flags, k: string) {
  const v = flag(f, k);
  if (!v) throw new Error(`Missing --${k} <value>`);
  return v;
}
function num(f: Flags, k: string, d: number) {
  const r = flag(f, k);
  const n = r == null ? d : Number(r);
  if (!Number.isFinite(n)) throw new Error(`Invalid --${k}: ${r}`);
  return n;
}
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
function keyString(v: any): string {
  return typeof v === "string"
    ? v
    : (v?.pubkey?.toBase58?.() ??
        v?.pubkey?.toString?.() ??
        v?.toBase58?.() ??
        String(v));
}
function rawAmount(v: any): bigint {
  const s = v?.uiTokenAmount?.amount ?? v?.amount ?? "0";
  return /^-?\d+$/.test(String(s)) ? BigInt(s) : 0n;
}
function decimals(v: any): number {
  const n = Number(v?.uiTokenAmount?.decimals ?? v?.decimals ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

async function discoverPools(mint: string): Promise<string[]> {
  const u = new URL("https://api-v3.raydium.io/pools/info/mint");
  u.searchParams.set("mint1", mint);
  u.searchParams.set("poolType", "all");
  u.searchParams.set("poolSortField", "liquidity");
  u.searchParams.set("sortType", "desc");
  u.searchParams.set("pageSize", "100");
  u.searchParams.set("page", "1");
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Raydium pool discovery HTTP ${r.status}`);
  const body: any = await r.json();
  const rows = body?.data?.data ?? body?.data ?? [];
  const ids: string[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id ?? row?.poolId ?? row?.address ?? "");
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function rpcFullPages(
  rpcUrl: string,
  address: string,
  limitPages: number,
): Promise<any[]> {
  const out: any[] = [];
  let paginationToken: string | undefined;
  for (let page = 0; page < limitPages; page++) {
    const body: any = {
      jsonrpc: "2.0",
      id: page + 1,
      method: "getTransactionsForAddress",
      params: [
        address,
        {
          transactionDetails: "full",
          sortOrder: "asc",
          commitment: "finalized",
          limit: 100,
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
          ...(paginationToken ? { paginationToken } : {}),
          filters: { status: "succeeded" },
        },
      ],
    };
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const p: any = await r.json().catch(() => null);
    if (!r.ok || p?.error)
      throw new Error(
        `gTFA unavailable: HTTP ${r.status} ${JSON.stringify(p?.error ?? p ?? {})}`,
      );
    const data = p?.result?.data ?? [];
    out.push(...data);
    paginationToken = p?.result?.paginationToken;
    if (!paginationToken || data.length === 0) break;
    await sleep(25);
  }
  return out;
}

async function standardFallback(
  connection: any,
  address: string,
  maxSignatures: number,
): Promise<any[]> {
  const signatures: any[] = [];
  let before: string | undefined;
  while (signatures.length < maxSignatures) {
    const page = await connection.getSignaturesForAddress(
      new PublicKey(address),
      {
        limit: Math.min(1000, maxSignatures - signatures.length),
        ...(before ? { before } : {}),
      },
      "finalized",
    );
    if (!page.length) break;
    signatures.push(...page.filter((x: any) => x.err == null));
    before = page.at(-1)?.signature;
    if (page.length < 1000) break;
  }
  signatures.sort((a, b) => a.slot - b.slot);
  const out: any[] = [];
  for (let i = 0; i < signatures.length; i += 100) {
    const slice = signatures.slice(i, i + 100);
    const txs = await connection.getParsedTransactions(
      slice.map((x: any) => x.signature),
      { commitment: "finalized", maxSupportedTransactionVersion: 0 },
    );
    for (let j = 0; j < txs.length; j++) {
      const tx = txs[j];
      if (tx)
        out.push({
          slot: tx.slot,
          blockTime: tx.blockTime,
          transaction: tx.transaction,
          meta: tx.meta,
        });
    }
    await sleep(25);
  }
  return out;
}

function parseTrades(row: any, mint: string, pool: string): Trade[] {
  const tx: any = row?.transaction ? row : null;
  if (!tx?.transaction || !tx?.meta) return [];
  const keys = (tx.transaction.message?.accountKeys ?? []).map(keyString);
  const sig = String(tx.transaction.signatures?.[0] ?? "");
  const fee = BigInt(tx.meta.fee ?? 0);
  const preToken: any[] = tx.meta.preTokenBalances ?? [];
  const postToken: any[] = tx.meta.postTokenBalances ?? [];
  const ownerSet = new Set<string>();
  for (const b of [...preToken, ...postToken])
    if (b?.mint === mint && b?.owner) ownerSet.add(String(b.owner));
  const out: Trade[] = [];
  for (const owner of ownerSet) {
    let tPre = 0n,
      tPost = 0n,
      wPre = 0n,
      wPost = 0n,
      dec = 0;
    for (const b of preToken) {
      if (b?.owner !== owner) continue;
      if (b?.mint === mint) {
        tPre += rawAmount(b);
        dec = decimals(b);
      }
      if (b?.mint === WSOL) wPre += rawAmount(b);
    }
    for (const b of postToken) {
      if (b?.owner !== owner) continue;
      if (b?.mint === mint) {
        tPost += rawAmount(b);
        dec = decimals(b);
      }
      if (b?.mint === WSOL) wPost += rawAmount(b);
    }
    const tokenDelta = tPost - tPre;
    if (tokenDelta === 0n) continue;
    const ownerIndex = keys.indexOf(owner);
    let nativeDelta = 0n;
    if (ownerIndex >= 0) {
      nativeDelta =
        BigInt(tx.meta.postBalances?.[ownerIndex] ?? 0) -
        BigInt(tx.meta.preBalances?.[ownerIndex] ?? 0);
      if (ownerIndex === 0) nativeDelta += fee;
    }
    const quoteDeltaSol = Number(nativeDelta + (wPost - wPre)) / 1e9;
    const tokenUi = Number(tokenDelta) / 10 ** dec;
    const side =
      tokenDelta > 0n && quoteDeltaSol < 0
        ? "buy"
        : tokenDelta < 0n && quoteDeltaSol > 0
          ? "sell"
          : null;
    if (!side || !Number.isFinite(tokenUi) || tokenUi === 0) continue;
    const sol = Math.abs(quoteDeltaSol);
    const price = sol / Math.abs(tokenUi);
    if (!(price > 0 && Number.isFinite(price))) continue;
    out.push({
      signature: sig,
      slot: Number(tx.slot ?? row.slot ?? 0),
      blockTime: Number(tx.blockTime ?? row.blockTime ?? 0),
      tradedAtMs: Number(tx.blockTime ?? row.blockTime ?? 0) * 1000,
      owner,
      side,
      tokenDeltaRaw: tokenDelta.toString(),
      tokenDeltaUi: Math.abs(tokenUi),
      solDeltaUi: sol,
      priceSol: price,
      pool,
      source: "raydium",
    });
  }
  return out;
}

export async function runRaydiumHistoryBackfill(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const mint = flag(flags, "token") ?? required(flags, "mint");
  new PublicKey(mint);
  const slrd = createTraderSolard();
  const rpcUrl = slrd.connection().rpcEndpoint;
  let pools = flag(flags, "pool")
    ? [flag(flags, "pool")!]
    : await m("discover Raydium pools", () => discoverPools(mint));
  const maxPools = Math.max(1, Math.trunc(num(flags, "max-pools", 8)));
  pools = pools.slice(0, maxPools);
  if (!pools.length) throw new Error(`No Raydium pools discovered for ${mint}`);
  const pageLimit = Math.max(1, Math.trunc(num(flags, "max-pages", 10000)));
  const maxSignatures = Math.max(
    100,
    Math.trunc(num(flags, "max-signatures", 1_000_000)),
  );
  const bySigPool = new Map<string, any>();
  let usedGtfa = true;
  for (const pool of pools) {
    const rows = await m(
      {
        start: () => `backfill ${pool}`,
        end: (v: any[]) => ({ transactions: v.length }),
      },
      async () => {
        try {
          return await rpcFullPages(rpcUrl, pool, pageLimit);
        } catch (error) {
          usedGtfa = false;
          return await standardFallback(slrd.connection(), pool, maxSignatures);
        }
      },
    );
    for (const row of rows) {
      const sig = String(row?.transaction?.signatures?.[0] ?? "");
      if (sig && !bySigPool.has(sig)) bySigPool.set(sig, { row, pool });
    }
  }
  const trades: Trade[] = [];
  for (const { row, pool } of bySigPool.values())
    trades.push(...parseTrades(row, mint, pool));
  trades.sort(
    (a, b) =>
      a.tradedAtMs - b.tradedAtMs ||
      a.slot - b.slot ||
      a.signature.localeCompare(b.signature),
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve(
    flag(flags, "out") ??
      `backtest-results/${mint}-raydium-${stamp}/trades.jsonl`,
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    trades.map((x) => JSON.stringify(x)).join("\n") +
      (trades.length ? "\n" : ""),
  );
  const meta = {
    mint,
    pools,
    transactions: bySigPool.size,
    trades: trades.length,
    from: trades[0]?.tradedAtMs
      ? new Date(trades[0].tradedAtMs).toISOString()
      : null,
    to: trades.at(-1)?.tradedAtMs
      ? new Date(trades.at(-1)!.tradedAtMs).toISOString()
      : null,
    transport: usedGtfa ? "getTransactionsForAddress" : "standard-rpc-fallback",
    out,
  };
  writeFileSync(
    resolve(dirname(out), "meta.json"),
    JSON.stringify(meta, null, 2) + "\n",
  );
  console.log(JSON.stringify(meta, null, 2));
  return meta;
}
if (import.meta.main)
  runRaydiumHistoryBackfill().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
