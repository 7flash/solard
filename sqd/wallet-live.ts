// Minimal realtime wallet activity logger (no DB, no checkpoint).
// Uses absolute pre/post sums so event labels are correct for wallets
// that already held tokens before the process started.
//
// Usage:
//   bun run sqd/wallet-live.ts <WALLET> [WALLET2 ...]
//
// Optional:
//   LOOKBACK_SLOTS=200
//   PORTAL_URL=...
import {
  getPortalHead,
  measure,
  type PortalBlock,
  type PortalQuery,
  type PortalTokenBalance,
  runPortal,
  timestampMs,
  transactionMap,
} from "./shared/portal.ts";

type EventType = "NEW" | "INCREASE" | "DECREASE" | "EXIT";

function bigintValue(value: string | number | undefined): bigint {
  return value === undefined ? 0n : BigInt(value);
}

function classify(prev: bigint, next: bigint): EventType {
  if (prev === 0n && next > 0n) return "NEW";
  if (next === 0n && prev > 0n) return "EXIT";
  return next > prev ? "INCREASE" : "DECREASE";
}

interface OwnerMintChange {
  owner: string;
  mint: string;
  preSum: bigint;
  postSum: bigint;
}

function aggregateChanges(
  rows: PortalTokenBalance[],
  watchedWallets: ReadonlySet<string>,
): OwnerMintChange[] {
  const map = new Map<string, OwnerMintChange>();
  const get = (owner: string, mint: string) => {
    const key = `${owner}:${mint}`;
    let e = map.get(key);
    if (!e) {
      e = { owner, mint, preSum: 0n, postSum: 0n };
      map.set(key, e);
    }
    return e;
  };

  for (const row of rows) {
    if (row.preOwner && row.preMint && watchedWallets.has(row.preOwner)) {
      get(row.preOwner, row.preMint).preSum += bigintValue(row.preAmount);
    }
    if (row.postOwner && row.postMint && watchedWallets.has(row.postOwner)) {
      get(row.postOwner, row.postMint).postSum += bigintValue(row.postAmount);
    }
  }

  return [...map.values()].filter((e) => e.postSum !== e.preSum);
}

function buildQuery(wallets: string[], from: number): PortalQuery {
  return {
    type: "solana",
    fromBlock: from,
    fields: {
      block: {
        number: true,
        hash: true,
        parentNumber: true,
        parentHash: true,
        height: true,
        timestamp: true,
      },
      transaction: {
        transactionIndex: true,
        signatures: true,
        err: true,
      },
      tokenBalance: {
        transactionIndex: true,
        account: true,
        preMint: true,
        postMint: true,
        preOwner: true,
        postOwner: true,
        preAmount: true,
        postAmount: true,
      },
    },
    tokenBalances: [
      { preOwner: wallets, transaction: true },
      { postOwner: wallets, transaction: true },
    ],
  };
}

async function main() {
  const wallets = process.argv
    .slice(2)
    .filter((v) => !v.startsWith("--") && v.length > 30);

  if (wallets.length === 0) {
    console.error("usage: bun run sqd/wallet-live.ts <WALLET> [WALLET2 ...]");
    process.exit(1);
  }

  const watched = new Set(wallets);
  const portal =
    process.env.PORTAL_URL ?? "https://portal.sqd.dev/datasets/solana-mainnet";
  const lookback = Math.max(0, Number(process.env.LOOKBACK_SLOTS ?? 200));

  const head = await getPortalHead(portal, false);
  const from = Math.max(0, head.number - lookback);

  // owner:mint → last known absolute balance
  const balances = new Map<string, bigint>();

  console.log(
    `[wallet] watching ${wallets.length} wallet(s) from=${from} head=${head.number} lookback=${lookback}`,
  );
  for (const w of wallets) console.log(`[wallet]   ${w}`);

  let lastProgress = 0;

  await runPortal({
    name: "wallet-live",
    portalUrl: portal,
    finalized: false,
    from,
    buildQuery: (cursor) => buildQuery(wallets, cursor),
    onBlock: async (block: PortalBlock) => {
      const rows = block.tokenBalances ?? [];
      const slot = block.header.number;

      if (rows.length > 0 || slot - lastProgress >= 40) {
        process.stdout.write(
          `\x1b[2K\r[wallet] slot=${slot}  tokenBalances=${rows.length}   `,
        );
        lastProgress = slot;
      }

      if (rows.length === 0) return;

      const txs = transactionMap(block);
      const byTx = new Map<number, PortalTokenBalance[]>();
      for (const r of rows) {
        const list = byTx.get(r.transactionIndex) ?? [];
        list.push(r);
        byTx.set(r.transactionIndex, list);
      }

      for (const txIndex of [...byTx.keys()].sort((a, b) => a - b)) {
        const tx = txs.get(txIndex);
        if (!tx || tx.err) continue;
        const sig = tx.signatures?.[0];
        if (!sig) continue;

        for (const c of aggregateChanges(byTx.get(txIndex)!, watched)) {
          const key = `${c.owner}:${c.mint}`;
          const prev = balances.has(key) ? balances.get(key)! : c.preSum;
          const next = prev + (c.postSum - c.preSum);

          if (next < 0n) {
            console.warn(
              `\n[wallet] WARNING negative balance owner=${c.owner.slice(0, 8)}… ` +
                `mint=${c.mint.slice(0, 8)}… next=${next} — clamping`,
            );
          }
          const safeNext = next < 0n ? 0n : next;
          balances.set(key, safeNext);

          const event = classify(prev, safeNext);
          if (prev === safeNext) continue;

          console.log(
            `\n[wallet] ${event.padEnd(8)} wallet=${c.owner.slice(0, 8)}…  ` +
              `mint=${c.mint.slice(0, 8)}…  ` +
              `δ=${(c.postSum - c.preSum).toString().padStart(14)}  ` +
              `bal=${safeNext.toString().padStart(14)}  ` +
              `slot=${slot}  ${sig.slice(0, 12)}…`,
          );
        }
      }
    },
  });
}

if (import.meta.main) {
  await measure.root({ start: () => "wallet-live" }, main).catch((err) => {
    console.error("[wallet] fatal", err);
    process.exitCode = 1;
  });
}
