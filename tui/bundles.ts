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
