// Unified realtime Pump monitor (refactored)
//
// - Auto-detects create / create_v2
// - Tracks holders with bounded mint set (FIFO eviction)
// - Tracks explicit wallets
// - Self-healing balances (prefer postSum)
// - Dedupe overlapping tokenBalance rows
// - Runtime stdin control
//
// Usage:
//   bun run sqd/pump-monitor.ts
//
// Env:
//   LOOKBACK_SLOTS=400
//   MAX_MINTS=300
//   REORG_DEPTH=48
//   PORTAL_URL=...
//
// Commands: status | mints | wallets | drop <mint> | dropall | watch <wallet> | unwatch <wallet> | help
import * as readline from "node:readline";
import {
  getPortalHead,
  measure,
  type PortalBlock,
  type PortalQuery,
  runPortal,
  transactionMap,
} from "./shared/portal.ts";
import {
  PUMP_PROGRAM,
  CREATE_D8,
  CREATE_V2_D8,
  CREATE_LAYOUT,
  base58Decode,
  decodeCreateArgs,
} from "./monitor/pump-decode.ts";
import { BalanceStore } from "./monitor/balance-store.ts";
import { MintRegistry } from "./monitor/mint-registry.ts";
import { collectChanges, classify } from "./monitor/aggregate.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const portal =
  process.env.PORTAL_URL ?? "https://portal.sqd.dev/datasets/solana-mainnet";
const lookback = Math.max(
  0,
  Number(process.env.LOOKBACK_SLOTS ?? process.env.SQD_LIVE_LOOKBACK ?? 400),
);
const maxMints = Math.max(10, Number(process.env.MAX_MINTS ?? 300));
const reorgDepth = Math.max(8, Number(process.env.REORG_DEPTH ?? 48));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const mints = new MintRegistry(maxMints);
const wallets = new Set<string>();
const store = new BalanceStore(reorgDepth);

// ---------------------------------------------------------------------------
// Query (rebuilt every continuation — critical for filter freshness)
// ---------------------------------------------------------------------------
function buildQuery(from: number): PortalQuery {
  const mintList = mints.values();
  const walletList = [...wallets];

  const tokenBalances: any[] = [];
  if (mintList.length > 0) {
    tokenBalances.push({ preMint: mintList, transaction: true });
    tokenBalances.push({ postMint: mintList, transaction: true });
  }
  if (walletList.length > 0) {
    tokenBalances.push({ preOwner: walletList, transaction: true });
    tokenBalances.push({ postOwner: walletList, transaction: true });
  }

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
      transaction: { transactionIndex: true, signatures: true, err: true },
      instruction: {
        transactionIndex: true,
        instructionAddress: true,
        programId: true,
        accounts: true,
        data: true,
        isCommitted: true,
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
    instructions: [
      {
        programId: [PUMP_PROGRAM],
        d8: [CREATE_D8, CREATE_V2_D8],
        isCommitted: true,
        transaction: true,
      },
    ],
    ...(tokenBalances.length > 0 ? { tokenBalances } : {}),
  };
}

// ---------------------------------------------------------------------------
// Stdin control
// ---------------------------------------------------------------------------
function startControl() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const handle = (line: string) => {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    const cmd = (parts[0] ?? "").toLowerCase();
    const arg = parts[1] ?? "";

    switch (cmd) {
      case "help":
      case "?":
        console.log(`
commands:
  status                 counts
  mints                  list watched mints
  wallets                list watched wallets
  drop <mint>            stop tracking mint
  dropall                clear all mints
  watch <wallet>         track wallet
  unwatch <wallet>       stop tracking wallet
  help
`);
        break;
      case "status":
        console.log(
          `[status] mints=${mints.size}/${maxMints} wallets=${wallets.size} balances=${store.size}`,
        );
        break;
      case "mints":
        if (mints.size === 0) console.log("(none)");
        else {
          for (const { mint, meta } of mints.list()) {
            console.log(
              `  ${mint}  ${meta.name} ($${meta.symbol}) slot=${meta.slot}`,
            );
          }
        }
        break;
      case "wallets":
        if (wallets.size === 0) console.log("(none)");
        else for (const w of wallets) console.log(`  ${w}`);
        break;
      case "drop":
        if (!arg) {
          console.log("usage: drop <mint>");
          break;
        }
        if (mints.delete(arg)) {
          store.deletePrefix(`m:${arg}:`);
          console.log(
            `[ctrl] dropped ${arg.slice(0, 12)}…  (mints=${mints.size})`,
          );
        } else {
          console.log(`[ctrl] not watched: ${arg.slice(0, 12)}…`);
        }
        break;
      case "dropall":
        mints.clear();
        store.deletePrefix("m:");
        console.log("[ctrl] dropped all mints");
        break;
      case "watch":
        if (!arg || arg.length < 32) {
          console.log("usage: watch <wallet>");
          break;
        }
        if (wallets.has(arg)) {
          console.log(`[ctrl] already watching ${arg.slice(0, 12)}…`);
        } else {
          wallets.add(arg);
          console.log(
            `[ctrl] watch ${arg.slice(0, 12)}…  (wallets=${wallets.size})`,
          );
        }
        break;
      case "unwatch":
        if (!arg) {
          console.log("usage: unwatch <wallet>");
          break;
        }
        if (wallets.delete(arg)) {
          store.deletePrefix(`w:${arg}:`);
          console.log(`[ctrl] unwatch ${arg.slice(0, 12)}…`);
        } else {
          console.log(`[ctrl] not watched: ${arg.slice(0, 12)}…`);
        }
        break;
      case "":
        break;
      default:
        console.log(`unknown: ${cmd}  (help)`);
    }
  };

  rl.on("line", handle);
  rl.on("close", () => {});
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const head = await getPortalHead(portal, false);
  const from = Math.max(0, head.number - lookback);

  console.log(
    `[monitor] from=${from} head=${head.number} lookback=${lookback} maxMints=${maxMints}`,
  );
  console.log(`[monitor] type "help" for commands`);
  startControl();

  let lastProgress = 0;
  let lastHash: string | undefined;
  let lastSlot = from - 1;

  await runPortal({
    name: "pump-monitor",
    portalUrl: portal,
    finalized: false,
    from,
    // Important: called on every continuation so new mints enter the filter ASAP
    buildQuery: (cursor) => buildQuery(cursor),
    onBlock: async (block: PortalBlock) => {
      const slot = block.header.number;
      const hash = block.header.hash;
      const parentHash = block.header.parentHash;
      const txs = transactionMap(block);
      const touched: string[] = [];

      // parentHash continuity check
      if (
        lastHash &&
        parentHash &&
        parentHash !== lastHash &&
        slot === lastSlot + 1
      ) {
        console.warn(
          `\n[monitor] parentHash mismatch at ${slot} — possible fork`,
        );
        const common = store.findCommon([{ number: lastSlot, hash: lastHash }]);
        if (common !== null) {
          const n = store.rollbackTo(common - 1);
          console.warn(`[monitor] rolled back ${n} block(s)`);
        }
      }

      // ----- 1. Creates -----
      for (const ix of block.instructions ?? []) {
        if (ix.programId !== PUMP_PROGRAM || ix.isCommitted === false) continue;
        if (!ix.data || !ix.accounts) continue;

        let data: Uint8Array;
        try {
          data = base58Decode(ix.data);
        } catch {
          continue;
        }
        const args = decodeCreateArgs(data);
        if (!args) continue;

        const layout = CREATE_LAYOUT[args.kind];
        if (ix.accounts.length < layout.minAccounts) continue;

        const tx = txs.get(ix.transactionIndex);
        if (!tx || tx.err) continue;
        const sig = tx.signatures?.[0];
        if (!sig) continue;

        const mint = ix.accounts[layout.mint];
        const bondingCurve = ix.accounts[layout.bondingCurve];
        const user = ix.accounts[layout.user];
        if (!mint || !bondingCurve || !user) continue;

        if (!mints.has(mint)) {
          const evicted = mints.add(mint, {
            name: args.name,
            symbol: args.symbol,
            slot,
          });
          for (const e of evicted) {
            store.deletePrefix(`m:${e}:`);
            console.log(`[monitor] evicted oldest mint ${e.slice(0, 12)}…`);
          }

          console.log(
            `\n🚀 NEW ${args.name} ($${args.symbol}) [${args.kind}]` +
              (args.isMayhemMode ? " mayhem" : "") +
              `\n   mint   ${mint}` +
              `\n   curve  ${bondingCurve}` +
              `\n   user   ${user}` +
              `\n   creator ${args.creator ?? user}` +
              `\n   sig    ${sig}` +
              `\n   slot   ${slot}` +
              `\n   mints  ${mints.size}/${maxMints}`,
          );
        }
      }

      // ----- 2. Balance changes -----
      const rows = block.tokenBalances ?? [];
      if (rows.length === 0) {
        if (slot - lastProgress >= 50) {
          // Avoid clobbering active readline input as much as possible
          process.stderr.write(
            `\x1b[2K\r[monitor] slot=${slot} mints=${mints.size} wallets=${wallets.size}   `,
          );
          lastProgress = slot;
        }
        store.commitBlock(slot, hash, parentHash, touched);
        lastHash = hash;
        lastSlot = slot;
        return;
      }

      const byTx = new Map<number, typeof rows>();
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

        for (const c of collectChanges(byTx.get(txIndex)!, mints, wallets)) {
          if (c.kind === "holder" && !mints.has(c.mint)) continue;
          if (c.kind === "wallet" && !wallets.has(c.owner)) continue;

          const result = store.applyObserved(c.key, c.preSum, c.postSum);
          if (!result) continue;
          touched.push(c.key);

          const { prev, next } = result;
          const event = classify(prev, next);
          const delta = next - prev;

          if (c.kind === "holder") {
            const meta = mints.getMeta(c.mint);
            const label = meta ? meta.symbol : c.mint.slice(0, 8);
            console.log(
              `\n[holder] ${event.padEnd(8)} $${label}  ` +
                `owner=${c.owner.slice(0, 8)}…  ` +
                `δ=${delta.toString().padStart(12)}  ` +
                `bal=${next.toString().padStart(12)}  ` +
                `slot=${slot}  ${sig.slice(0, 12)}…`,
            );
          } else {
            console.log(
              `\n[wallet] ${event.padEnd(8)} wallet=${c.owner.slice(0, 8)}…  ` +
                `mint=${c.mint.slice(0, 8)}…  ` +
                `δ=${delta.toString().padStart(12)}  ` +
                `bal=${next.toString().padStart(12)}  ` +
                `slot=${slot}  ${sig.slice(0, 12)}…`,
            );
          }
        }
      }

      store.commitBlock(slot, hash, parentHash, touched);
      lastHash = hash;
      lastSlot = slot;
      lastProgress = slot;
    },
  });
}

if (import.meta.main) {
  await measure.root({ start: () => "pump-monitor" }, main).catch((err) => {
    console.error("[monitor] fatal", err);
    process.exitCode = 1;
  });
}
