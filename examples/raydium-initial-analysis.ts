#!/usr/bin/env bun
import {
  createTraderSolard,
  getTokenHistoryCoverage,
  loadTokenHistoryTrades,
} from "@solard/sdk";

const mint = process.argv[2];
if (!mint)
  throw new Error(
    "Usage: slrd run examples/raydium-initial-analysis.ts <mint> [window-seconds]",
  );
const windowMs = Math.max(1, Number(process.argv[3] ?? 60)) * 1000;
const trades = loadTokenHistoryTrades(mint)
  .filter((t: any) => t.owner && t.side === "buy")
  .sort((a: any, b: any) => a.tradedAtMs - b.tradedAtMs);
if (!trades.length)
  throw new Error(`No buy history for ${mint}; run slrd token backfill first`);
const start = trades[0]!.tradedAtMs;
const early = trades.filter((t: any) => t.tradedAtMs <= start + windowMs);
const owners = new Map<string, any>();
for (const t of early) {
  const r = owners.get(t.owner) ?? {
    owner: t.owner,
    tokens: 0,
    sol: 0,
    trades: 0,
  };
  r.tokens += Math.abs(t.tokenDeltaUi);
  r.sol += Math.abs(t.solDeltaUi);
  r.trades++;
  owners.set(t.owner, r);
}
const rows = [...owners.values()].sort((a, b) => b.tokens - a.tokens);
const total = rows.reduce((n, r) => n + r.tokens, 0);
const share = (n: number) =>
  (rows.slice(0, n).reduce((x, r) => x + r.tokens, 0) / total) * 100;
console.log(
  `INITIAL RAYDIUM ANALYSIS\nMint: ${mint}\nCoverage: ${JSON.stringify(getTokenHistoryCoverage(mint))}\nWindow: ${windowMs / 1000}s from ${new Date(start).toISOString()}\nEarly buyers: ${rows.length}\nTop1=${share(1).toFixed(2)}% Top5=${share(5).toFixed(2)}% Top10=${share(10).toFixed(2)}%\n`,
);
rows
  .slice(0, 25)
  .forEach((r, i) =>
    console.log(
      `${String(i + 1).padStart(3)} ${r.owner} tokens=${r.tokens.toFixed(4)} sol=${r.sol.toFixed(6)} trades=${r.trades}`,
    ),
  );
const slrd = createTraderSolard();
const largest = await slrd
  .connection()
  .getTokenLargestAccounts(
    new (await import("@solana/web3.js")).PublicKey(mint),
  );
console.log(
  "\nCURRENT LARGEST TOKEN ACCOUNTS (snapshot, not initial allocation)",
);
largest.value
  .slice(0, 20)
  .forEach((r: any, i: number) =>
    console.log(
      `${String(i + 1).padStart(3)} ${r.address.toBase58()} ${r.uiAmountString ?? r.amount}`,
    ),
  );
slrd.close();
