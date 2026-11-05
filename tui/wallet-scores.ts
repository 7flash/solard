/** Lifetime wallet scores from traderStats rows (realized P&L, wins, entry rank, median entry/exit cap, multiple,
 * hold time). Pure: the bridge runs it in a worker over the whole table (millions of rows take ~40s, which must
 * never block the page), and on the few rows of one wallet's coins for the wallet page. */
export type StatRow = { trader: string; mint: string; buys: number; sells: number; solIn: number; solOut: number; tokensBought: number; tokensSold: number;
  lastPriceSol: number | null; entryCapUsd?: number | null; exitCapUsd?: number | null; firstAtMs: number; lastAtMs: number };
export type WalletScore = { trader: string; pnlSol: number; realizedSol: number; openSol: number; coins: number; wins: number; trades: number; solIn: number;
  avgRankPct: number; earlyCoins: number; lastAtMs: number;
  /** Medians across coins: market cap at entry and exit, exit/entry multiple, minutes held (coins it sold). */
  medEntryCap: number | null; medExitCap: number | null; medMultiple: number | null; medHoldMin: number | null };

/** Per coin: latest trade price, number of buyers, and each wallet's entry rank (0 = first buyer). */
export function coinIndex(rows: StatRow[]) {
  const mark = new Map<string, { price: number; at: number }>(), byMint = new Map<string, StatRow[]>();
  for (const r of rows) {
    if (r.lastPriceSol != null && (mark.get(r.mint)?.at ?? 0) < r.lastAtMs) mark.set(r.mint, { price: r.lastPriceSol, at: r.lastAtMs });
    (byMint.get(r.mint) ?? byMint.set(r.mint, []).get(r.mint)!).push(r);
  }
  const rank = new Map<string, number>(), buyers = new Map<string, number>();
  for (const [mint, list] of byMint) {
    const b = list.filter(r => r.buys > 0).sort((a, c) => a.firstAtMs - c.firstAtMs);
    buyers.set(mint, b.length);
    b.forEach((r, i) => rank.set(`${r.trader}:${mint}`, i));
  }
  return { mark: new Map([...mark].map(([k, v]) => [k, v.price])), rank, buyers };
}

const med = (xs: number[]) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)]! : null; };

export function scoreWallet(trader: string, list: StatRow[], ix: ReturnType<typeof coinIndex>): WalletScore {
  let rankSum = 0, ranked = 0, early = 0;
  for (const r of list) {
    const rk = ix.rank.get(`${trader}:${r.mint}`), n = ix.buyers.get(r.mint) ?? 0;
    if (rk != null && n >= 10) { rankSum += rk / n; ranked++; if (rk / n <= 0.1) early++; }
  }
  return scoreFrom(trader, list, ix.mark, rankSum, ranked, early);
}

function scoreFrom(trader: string, list: StatRow[], mark: Map<string, number>, rankSum: number, ranked: number, early: number): WalletScore {
  let pnl = 0, realized = 0, open = 0, wins = 0, trades = 0, solIn = 0, last = 0;
  for (const r of list) {
    const held = Math.max(0, r.tokensBought - r.tokensSold), px = mark.get(r.mint) ?? r.lastPriceSol ?? 0;
    // Open holdings are shown but not scored: a bad firehose mark could make a wallet look like it made thousands.
    const o = Math.min(held * px, Math.max(0, r.solIn) * 10), p = r.solOut - r.solIn;
    pnl += p; realized += p; open += o; if (p > 0) wins++; trades += r.buys + r.sells; solIn += r.solIn; last = Math.max(last, r.lastAtMs);
  }
  const sold = list.filter(r => r.sells > 0);
  return { trader, pnlSol: pnl, realizedSol: realized, openSol: open, coins: list.length, wins, trades, solIn,
    avgRankPct: ranked ? rankSum / ranked * 100 : 0, earlyCoins: early, lastAtMs: last,
    medEntryCap: med(list.map(r => r.entryCapUsd ?? NaN)), medExitCap: med(sold.map(r => r.exitCapUsd ?? NaN)),
    medMultiple: med(sold.map(r => r.entryCapUsd && r.exitCapUsd ? r.exitCapUsd / r.entryCapUsd : NaN)),
    medHoldMin: med(sold.map(r => (r.lastAtMs - r.firstAtMs) / 60_000)) };
}

/** The same scores without holding the table: `byMint` and `byTrader` are the rows walked in that order through an index,
 * one coin and one wallet at a time. Memory is one coin's or one wallet's rows plus a small counter per wallet. */
export function scoreStream(byMint: Iterable<StatRow>, byTrader: Iterable<StatRow>, keep: (s: WalletScore) => boolean = () => true): WalletScore[] {
  const mark = new Map<string, number>(), ids = new Map<string, number>();
  let cap = 1 << 20, sum = new Float32Array(cap), ranked = new Uint32Array(cap), early = new Uint32Array(cap);
  const idOf = (t: string) => {
    let i = ids.get(t); if (i != null) return i;
    i = ids.size; ids.set(t, i);
    if (i >= cap) { cap *= 2; const s = new Float32Array(cap), r = new Uint32Array(cap), e = new Uint32Array(cap); s.set(sum); r.set(ranked); e.set(early); sum = s; ranked = r; early = e; }
    return i;
  };
  const closeCoin = (list: StatRow[]) => {
    let at = 0, price: number | null = null;
    for (const r of list) if (r.lastPriceSol != null && at < r.lastAtMs) { at = r.lastAtMs; price = r.lastPriceSol; }
    if (price != null) mark.set(list[0]!.mint, price);
    const b = list.filter(r => r.buys > 0); if (b.length < 10) return;
    b.sort((x, y) => x.firstAtMs - y.firstAtMs);
    b.forEach((r, i) => { const w = idOf(r.trader), q = i / b.length; sum[w]! += q; ranked[w]!++; if (q <= 0.1) early[w]!++; });
  };
  let group: StatRow[] = [];
  for (const r of byMint) { if (group.length && group[0]!.mint !== r.mint) { closeCoin(group); group = []; } group.push(r); }
  if (group.length) closeCoin(group);
  const out: WalletScore[] = [];
  const closeWallet = (list: StatRow[]) => {
    const t = list[0]!.trader, w = ids.get(t), s = w == null ? scoreFrom(t, list, mark, 0, 0, 0) : scoreFrom(t, list, mark, sum[w]!, ranked[w]!, early[w]!);
    if (keep(s)) out.push(s);
  };
  group = [];
  for (const r of byTrader) { if (group.length && group[0]!.trader !== r.trader) { closeWallet(group); group = []; } group.push(r); }
  if (group.length) closeWallet(group);
  return out;
}

export function scoreAll(rows: StatRow[]): WalletScore[] {
  const ix = coinIndex(rows), byWallet = new Map<string, StatRow[]>();
  for (const r of rows) (byWallet.get(r.trader) ?? byWallet.set(r.trader, []).get(r.trader)!).push(r);
  const out: WalletScore[] = [];
  for (const [trader, list] of byWallet) out.push(scoreWallet(trader, list, ix));
  return out;
}
