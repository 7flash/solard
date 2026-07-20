import { PublicKey } from "@solana/web3.js";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const DEFAULT_PUMP_SUPPLY_UI = 1_000_000_000;
export const LAMPORTS_PER_SOL = 1_000_000_000;

export type Raw = Record<string, any>;

export type ParsedTerminalTrade = {
  id: string;
  mint: string;
  signature: string;
  slot: number;
  owner: string | null;
  side: "buy" | "sell" | "unknown";
  tokenDeltaUi: number;
  solDeltaUi: number;
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  source: string;
  rawJson: string;
  createdAtMs: number;
};

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function accountKeys(tx: Raw): string[] {
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  return keys.map((item: any) => {
    if (typeof item === "string") return item;
    if (typeof item?.pubkey === "string") return item.pubkey;
    return String(
      item?.pubkey?.toBase58?.() ??
        item?.toBase58?.() ??
        item?.toString?.() ??
        "",
    );
  });
}

function ownerSolDelta(tx: Raw, owner: string): bigint | null {
  const keys = accountKeys(tx);
  const idx = keys.findIndex((key) => key === owner);
  if (idx < 0) return null;
  const pre = tx?.meta?.preBalances?.[idx];
  const post = tx?.meta?.postBalances?.[idx];
  if (typeof pre !== "number" || typeof post !== "number") return null;
  return BigInt(post) - BigInt(pre);
}

function aggregateTokenBalances(
  rows: any[] | undefined,
): Map<
  string,
  { mint: string; owner: string; amount: bigint; decimals: number }
> {
  const out = new Map<
    string,
    { mint: string; owner: string; amount: bigint; decimals: number }
  >();
  for (const row of rows ?? []) {
    const mint = clean(row?.mint);
    const owner = clean(row?.owner);
    if (!mint || !owner) continue;
    let amount = 0n;
    try {
      amount = BigInt(String(row?.uiTokenAmount?.amount ?? "0"));
    } catch {
      amount = 0n;
    }
    const decimals = Number(row?.uiTokenAmount?.decimals ?? 6);
    const key = `${mint}:${owner}`;
    const prev = out.get(key);
    if (prev) prev.amount += amount;
    else out.set(key, { mint, owner, amount, decimals });
  }
  return out;
}

function toUi(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

function looksLikePumpMint(value: string): boolean {
  return value.endsWith("pump");
}

export function validPublicKey(
  value: string | null | undefined,
): value is string {
  if (!value) return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

export function parseTerminalTradesFromTransaction(args: {
  tx: Raw;
  signature: string;
  source: string;
  solUsd: number | null;
}): ParsedTerminalTrade[] {
  const tx = args.tx;
  const slot = Number(tx?.slot ?? 0);
  const now = Date.now();
  const pre = aggregateTokenBalances(tx?.meta?.preTokenBalances);
  const post = aggregateTokenBalances(tx?.meta?.postTokenBalances);
  const keys = new Set([...pre.keys(), ...post.keys()]);
  const out: ParsedTerminalTrade[] = [];

  for (const key of keys) {
    const before = pre.get(key);
    const after = post.get(key);
    const mint = after?.mint ?? before?.mint ?? "";
    const owner = after?.owner ?? before?.owner ?? "";
    if (!validPublicKey(mint) || !validPublicKey(owner)) continue;
    if (!looksLikePumpMint(mint)) continue;
    const decimals = after?.decimals ?? before?.decimals ?? 6;
    const beforeRaw = before?.amount ?? 0n;
    const afterRaw = after?.amount ?? 0n;
    const deltaRaw = afterRaw - beforeRaw;
    if (deltaRaw === 0n) continue;

    const tokenDeltaUi = Math.abs(toUi(deltaRaw, decimals));
    const solDeltaLamports = ownerSolDelta(tx, owner);
    const solDeltaUi =
      solDeltaLamports == null
        ? 0
        : Math.abs(Number(solDeltaLamports) / LAMPORTS_PER_SOL);
    const priceSol =
      tokenDeltaUi > 0 && solDeltaUi > 0 ? solDeltaUi / tokenDeltaUi : null;
    const priceUsd =
      args.solUsd != null && priceSol != null ? priceSol * args.solUsd : null;
    const marketCapUsd =
      priceUsd != null ? priceUsd * DEFAULT_PUMP_SUPPLY_UI : null;

    out.push({
      id: `${args.signature}:${owner}:${mint}`,
      mint,
      signature: args.signature,
      slot,
      owner,
      side: deltaRaw > 0n ? "buy" : "sell",
      tokenDeltaUi,
      solDeltaUi,
      priceSol,
      priceUsd,
      marketCapUsd,
      source: args.source,
      rawJson: JSON.stringify({
        slot,
        owner,
        mint,
        deltaRaw: deltaRaw.toString(),
      }),
      createdAtMs: now,
    });
  }

  return out;
}

export function signatureFromParsedTx(tx: Raw): string | null {
  return clean(tx?.transaction?.signatures?.[0]) ?? clean(tx?.signature);
}
