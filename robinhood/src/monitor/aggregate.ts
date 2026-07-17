// Deduped pre/post aggregation for holder + wallet views.

export interface PortalTokenBalance {
  transactionIndex: number;
  account?: string;
  preMint?: string;
  postMint?: string;
  preOwner?: string;
  postOwner?: string;
  preAmount?: string | number;
  postAmount?: string | number;
}

export interface Change {
  key: string;
  mint: string;
  owner: string;
  preSum: bigint;
  postSum: bigint;
  kind: "holder" | "wallet";
}

function bi(v: string | number | undefined): bigint {
  return v === undefined ? 0n : BigInt(v);
}

/** Dedupe rows that may appear twice when mint + owner filters overlap. */
function dedupeRows(rows: PortalTokenBalance[]): PortalTokenBalance[] {
  const seen = new Set<string>();
  const out: PortalTokenBalance[] = [];
  for (const r of rows) {
    const id = `${r.transactionIndex}:${r.account ?? ""}:${r.preMint ?? ""}:${r.postMint ?? ""}:${r.preOwner ?? ""}:${r.postOwner ?? ""}:${r.preAmount ?? ""}:${r.postAmount ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(r);
  }
  return out;
}

export function collectChanges(
  rows: PortalTokenBalance[],
  watchedMints: ReadonlySet<string> | { has(m: string): boolean },
  watchedWallets: ReadonlySet<string>,
): Change[] {
  const unique = dedupeRows(rows);

  const holderMap = new Map<
    string,
    { mint: string; owner: string; pre: bigint; post: bigint }
  >();
  const walletMap = new Map<
    string,
    { mint: string; owner: string; pre: bigint; post: bigint }
  >();

  const hGet = (mint: string, owner: string) => {
    const k = `${mint}:${owner}`;
    let e = holderMap.get(k);
    if (!e) {
      e = { mint, owner, pre: 0n, post: 0n };
      holderMap.set(k, e);
    }
    return e;
  };
  const wGet = (owner: string, mint: string) => {
    const k = `${owner}:${mint}`;
    let e = walletMap.get(k);
    if (!e) {
      e = { mint, owner, pre: 0n, post: 0n };
      walletMap.set(k, e);
    }
    return e;
  };

  for (const row of unique) {
    if (row.preMint && row.preOwner) {
      if (watchedMints.has(row.preMint)) {
        hGet(row.preMint, row.preOwner).pre += bi(row.preAmount);
      }
      if (watchedWallets.has(row.preOwner)) {
        wGet(row.preOwner, row.preMint).pre += bi(row.preAmount);
      }
    }
    if (row.postMint && row.postOwner) {
      if (watchedMints.has(row.postMint)) {
        hGet(row.postMint, row.postOwner).post += bi(row.postAmount);
      }
      if (watchedWallets.has(row.postOwner)) {
        wGet(row.postOwner, row.postMint).post += bi(row.postAmount);
      }
    }
  }

  const out: Change[] = [];
  for (const e of holderMap.values()) {
    if (e.post !== e.pre) {
      out.push({
        key: `m:${e.mint}:${e.owner}`,
        mint: e.mint,
        owner: e.owner,
        preSum: e.pre,
        postSum: e.post,
        kind: "holder",
      });
    }
  }
  for (const e of walletMap.values()) {
    if (e.post !== e.pre) {
      out.push({
        key: `w:${e.owner}:${e.mint}`,
        mint: e.mint,
        owner: e.owner,
        preSum: e.pre,
        postSum: e.post,
        kind: "wallet",
      });
    }
  }
  return out;
}

export function classify(prev: bigint, next: bigint): string {
  if (prev === 0n && next > 0n) return "NEW";
  if (next === 0n && prev > 0n) return "EXIT";
  return next > prev ? "INCREASE" : "DECREASE";
}
