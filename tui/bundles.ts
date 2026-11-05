/** Coordinated buys: SLRD_BUNDLE_MIN (3)+ different wallets buying within ~1s of each other for nearly the same SOL
 * (within 1%). Independent traders do not do that (hush: 11 wallets at exactly 0.971 SOL in one second, two of them on
 * the follow list). Wallets in such a group are one operator: they do not count as a smart-wallet signal. */
export type BuyRow = { atMs: number; side: string | null; sol: number | null; trader: string | null };
export function bundledWallets(trades: BuyRow[], minWallets = 3): Set<string> {
  const buys = trades.filter(t => t.side === "buy" && t.trader && t.sol != null && t.sol > 0.01).sort((a, b) => a.atMs - b.atMs);
  const out = new Set<string>();
  for (let i = 0; i < buys.length; i++) {
    const a = buys[i]!, group = new Set<string>([a.trader!]);
    for (let j = i + 1; j < buys.length && buys[j]!.atMs - a.atMs <= 1_500; j++) {
      const b = buys[j]!;
      if (Math.abs(b.sol! - a.sol!) <= a.sol! * 0.01) group.add(b.trader!);
    }
    if (group.size >= minWallets) for (const w of group) out.add(w);
  }
  return out;
}

/** Share of a coin's wallets that bought as part of a bundle. */
export function bundleShare(trades: BuyRow[]) {
  const wallets = new Set(trades.flatMap(t => t.trader ? [t.trader] : []));
  return wallets.size ? bundledWallets(trades).size / wallets.size : 0;
}

/** Percent of supply bought in a coin's first 3 seconds, sold since or not: the launch bundle, whatever sizes it used and
 * wherever it moved the tokens. Counting what those wallets still hold misses a bundle that sold or moved on within minutes.
 * Across 100 tracked coins, those at 25% or more fell 30% without first rising 30% in 43% of cases, the rest in 14%. */
export function earlyBoughtPct(rows: { firstAtMs: number; tokensBought: number }[], supply = 1e9) {
  if (!rows.length) return null;
  const t0 = Math.min(...rows.map(r => r.firstAtMs));
  return rows.reduce((a, r) => a + (r.firstAtMs <= t0 + 3_000 ? r.tokensBought : 0), 0) / supply * 100;
}
