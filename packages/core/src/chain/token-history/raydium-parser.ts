import { NATIVE_MINT } from "@solana/spl-token";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";

import type {
  TokenHistoryConfidence,
  TokenHistoryRaw,
  TokenHistoryTrade,
} from "./types.ts";

const LAMPORTS_PER_SOL = 1_000_000_000;
const PARSER_VERSION = "raydium-history-v1";

type BalanceRow = {
  accountIndex: number;
  mint: string;
  owner: string | null;
  raw: bigint;
};

function keyText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof (value as any).toBase58 === "function") {
    return (value as any).toBase58();
  }
  if (value && typeof (value as any).pubkey?.toBase58 === "function") {
    return (value as any).pubkey.toBase58();
  }
  return null;
}

function accountKeys(tx: ParsedTransactionWithMeta): string[] {
  return ((tx.transaction.message as any).accountKeys ?? [])
    .map((row: unknown) => keyText(row))
    .filter((row: string | null): row is string => Boolean(row));
}

function signerKeys(tx: ParsedTransactionWithMeta): Set<string> {
  const rows = ((tx.transaction.message as any).accountKeys ?? []) as any[];
  const explicit = rows
    .filter((row) => row && typeof row === "object" && row.signer === true)
    .map((row) => keyText(row))
    .filter((row): row is string => Boolean(row));
  if (explicit.length) return new Set(explicit);

  const required = Number(
    (tx.transaction.message as any).header?.numRequiredSignatures ?? 0,
  );
  return new Set(accountKeys(tx).slice(0, Math.max(0, required)));
}

function rawAmount(row: any): bigint {
  try {
    return BigInt(String(row?.uiTokenAmount?.amount ?? "0"));
  } catch {
    return 0n;
  }
}

function balances(rows: readonly any[] | null | undefined): BalanceRow[] {
  return (rows ?? []).map((row) => ({
    accountIndex: Number(row.accountIndex),
    mint: String(row.mint ?? ""),
    owner: row.owner ? String(row.owner) : null,
    raw: rawAmount(row),
  }));
}

function ownerTokenDeltaRaw(
  tx: ParsedTransactionWithMeta,
  mint: string,
  owner: string,
): bigint {
  const pre = balances(tx.meta?.preTokenBalances);
  const post = balances(tx.meta?.postTokenBalances);
  const indices = new Set<number>();
  for (const row of [...pre, ...post]) {
    if (row.mint === mint && row.owner === owner) indices.add(row.accountIndex);
  }
  let total = 0n;
  for (const index of indices) {
    const before =
      pre.find((row) => row.accountIndex === index && row.mint === mint)?.raw ??
      0n;
    const after =
      post.find((row) => row.accountIndex === index && row.mint === mint)
        ?.raw ?? 0n;
    total += after - before;
  }
  return total;
}

function ownerTokenAccountRentDeltaLamports(
  tx: ParsedTransactionWithMeta,
  owner: string,
): bigint {
  if (!tx.meta) return 0n;
  const pre = balances(tx.meta.preTokenBalances);
  const post = balances(tx.meta.postTokenBalances);
  const byIndex = new Map<number, { pre?: BalanceRow; post?: BalanceRow }>();
  for (const row of pre)
    byIndex.set(row.accountIndex, {
      ...(byIndex.get(row.accountIndex) ?? {}),
      pre: row,
    });
  for (const row of post)
    byIndex.set(row.accountIndex, {
      ...(byIndex.get(row.accountIndex) ?? {}),
      post: row,
    });

  let total = 0n;
  for (const [index, pair] of byIndex) {
    const balanceOwner = pair.post?.owner ?? pair.pre?.owner ?? null;
    if (balanceOwner !== owner) continue;
    const before = BigInt(Math.trunc(Number(tx.meta.preBalances[index] ?? 0)));
    const after = BigInt(Math.trunc(Number(tx.meta.postBalances[index] ?? 0)));
    let accountLamportDelta = after - before;
    const mint = pair.post?.mint ?? pair.pre?.mint;
    // A WSOL token account's lamports move with the wrapped token amount. Remove
    // that component here; it is added explicitly as wsolDelta below.
    if (mint === NATIVE_MINT.toBase58()) {
      const tokenDelta = (pair.post?.raw ?? 0n) - (pair.pre?.raw ?? 0n);
      accountLamportDelta -= tokenDelta;
    }
    total += accountLamportDelta;
  }
  return total;
}

function economicSolDeltaLamports(
  tx: ParsedTransactionWithMeta,
  owner: string,
): {
  economic: bigint | null;
  nativeWalletDelta: bigint | null;
  feeLamports: bigint;
  tokenAccountRentDelta: bigint;
  wsolDelta: bigint;
} {
  const keys = accountKeys(tx);
  const index = keys.indexOf(owner);
  const wsolDelta = ownerTokenDeltaRaw(tx, NATIVE_MINT.toBase58(), owner);
  if (index < 0 || !tx.meta) {
    return {
      economic: null,
      nativeWalletDelta: null,
      feeLamports: 0n,
      tokenAccountRentDelta: 0n,
      wsolDelta,
    };
  }
  const before = tx.meta.preBalances[index];
  const after = tx.meta.postBalances[index];
  if (before == null || after == null) {
    return {
      economic: null,
      nativeWalletDelta: null,
      feeLamports: 0n,
      tokenAccountRentDelta: 0n,
      wsolDelta,
    };
  }
  const nativeWalletDelta =
    BigInt(Math.trunc(Number(after))) - BigInt(Math.trunc(Number(before)));
  const feeLamports = keys[0] === owner ? BigInt(tx.meta.fee ?? 0) : 0n;
  const tokenAccountRentDelta = ownerTokenAccountRentDeltaLamports(tx, owner);
  return {
    nativeWalletDelta,
    feeLamports,
    tokenAccountRentDelta,
    wsolDelta,
    economic:
      nativeWalletDelta + feeLamports + tokenAccountRentDelta + wsolDelta,
  };
}

function candidateOwners(
  tx: ParsedTransactionWithMeta,
  mint: string,
): string[] {
  const signers = signerKeys(tx);
  const owners = new Set<string>();
  for (const row of [
    ...balances(tx.meta?.preTokenBalances),
    ...balances(tx.meta?.postTokenBalances),
  ]) {
    if (row.mint === mint && row.owner && signers.has(row.owner))
      owners.add(row.owner);
  }
  return [...owners];
}

export function parseRaydiumHistoryTransaction(args: {
  tx: ParsedTransactionWithMeta;
  signature: string;
  mint: string;
  decimals: number;
  supplyUi: number;
  historyOrder: number;
  scanAddress: string;
  confidence: TokenHistoryConfidence;
  updatedAtMs?: number;
}): { trades: TokenHistoryTrade[]; ambiguous: number } {
  const { tx } = args;
  if (!tx.meta || tx.meta.err || tx.blockTime == null)
    return { trades: [], ambiguous: 0 };

  const owners = candidateOwners(tx, args.mint);
  const trades: TokenHistoryTrade[] = [];
  let ambiguous = 0;

  for (const owner of owners) {
    const signedTokenDelta = ownerTokenDeltaRaw(tx, args.mint, owner);
    if (signedTokenDelta === 0n) continue;
    const economics = economicSolDeltaLamports(tx, owner);
    const quoteDelta = economics.economic;
    if (quoteDelta == null || quoteDelta === 0n) {
      ambiguous += 1;
      continue;
    }

    const side = signedTokenDelta > 0n ? "buy" : "sell";
    // Direction must agree: a buy consumes SOL, a sell receives SOL. This drops
    // transfers/airdrops and non-SOL quote trades that happen to touch Raydium.
    if (
      (side === "buy" && quoteDelta >= 0n) ||
      (side === "sell" && quoteDelta <= 0n)
    ) {
      ambiguous += 1;
      continue;
    }

    const tokenRawAbs =
      signedTokenDelta < 0n ? -signedTokenDelta : signedTokenDelta;
    const quoteRawAbs = quoteDelta < 0n ? -quoteDelta : quoteDelta;
    const tokenUi = Number(tokenRawAbs) / 10 ** args.decimals;
    const solUi = Number(quoteRawAbs) / LAMPORTS_PER_SOL;
    if (
      !(tokenUi > 0) ||
      !(solUi > 0) ||
      !Number.isFinite(tokenUi) ||
      !Number.isFinite(solUi)
    ) {
      ambiguous += 1;
      continue;
    }
    const priceSol = solUi / tokenUi;
    const marketCapSol = args.supplyUi > 0 ? priceSol * args.supplyUi : null;
    const raw: TokenHistoryRaw = {
      parserVersion: PARSER_VERSION,
      venue: "raydium",
      instructionKinds: ["signer-balance-delta"],
      instructionIndex: 0,
      historyOrder: args.historyOrder,
      scanAddress: args.scanAddress,
      scanKind: "pool",
      ownerTokenDeltaRaw: signedTokenDelta.toString(),
      nativeWalletDeltaLamports:
        economics.nativeWalletDelta?.toString() ?? null,
      networkFeeLamports: economics.feeLamports.toString(),
      tokenAccountRentDeltaLamports: economics.tokenAccountRentDelta.toString(),
      wsolDeltaRaw: economics.wsolDelta.toString(),
      economicQuoteDeltaLamports: quoteDelta.toString(),
      pricingStatus: "native-wsol-corrected",
      excludedExternalTransfersLamports: "0",
      marketCapSol,
    };
    const updatedAtMs = args.updatedAtMs ?? tx.blockTime * 1_000;
    trades.push({
      eventKey: [
        "token-history-v1",
        args.signature,
        args.mint,
        "raydium",
        side,
        owner,
      ].join(":"),
      mint: args.mint,
      signature: args.signature,
      slot: tx.slot,
      owner,
      side,
      tokenDeltaUi: tokenUi,
      solDeltaUi: solUi,
      priceSol,
      priceUsd: null,
      marketCapUsd: null,
      confidence: args.confidence,
      source: "history:raydium",
      rawJson: JSON.stringify(raw),
      tradedAtMs: tx.blockTime * 1_000,
      updatedAtMs,
      history: raw,
    });
  }
  return { trades, ambiguous };
}
