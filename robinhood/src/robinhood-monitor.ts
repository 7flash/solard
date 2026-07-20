// Robinhood Chain — Uniswap V3 new pools + token holders monitor
// Same UX as pump-monitor: auto-track new tokens, drop, watch wallets.
//
// Usage:
//   $env:SQD_API_KEY="..."
//   $env:PORTAL_URL="https://portal.sqd.dev/datasets/robinhood-mainnet"  # or your private URL
//   bun run sqd/robinhood-monitor.ts
//
// Env:
//   PORTAL_URL          required for private Robinhood dataset
//   SQD_API_KEY         Bearer token for private portal
//   FACTORY             Uniswap V3 Factory (default: Robinhood deployment)
//   LOOKBACK_BLOCKS=200
//   MAX_TOKENS=300
//
// Commands: status | tokens | wallets | drop <token> | dropall | watch <wallet> | unwatch <wallet> | help
import * as readline from "node:readline";
import {
  getEvmHead,
  runEvmPortal,
  type EvmPortalBlock,
  type EvmPortalQuery,
  type EvmLog,
} from "./robinhood/evm-portal.ts";
import { BalanceStore } from "./monitor/balance-store.ts";
import { MintRegistry } from "./monitor/mint-registry.ts";
import { classify } from "./monitor/aggregate.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** Uniswap V3 Factory on Robinhood Chain (chainId 4663) */
const DEFAULT_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";

/** PoolCreated(address,address,uint24,int24,address) */
const POOL_CREATED_TOPIC =
  "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";

/** Transfer(address,address,uint256) */
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ZERO = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function norm(addr: string): string {
  return addr.toLowerCase();
}

function topicAddress(topic: string): string {
  // last 20 bytes of 32-byte topic
  return norm("0x" + topic.slice(-40));
}

function decodePoolCreated(log: EvmLog): {
  token0: string;
  token1: string;
  fee: number;
  pool: string;
} | null {
  if (log.topics.length < 4) return null;
  const token0 = topicAddress(log.topics[1]!);
  const token1 = topicAddress(log.topics[2]!);
  const fee = parseInt(log.topics[3]!.slice(-6), 16); // uint24 in topic
  // data: tickSpacing (int24) + pool (address) — pool is last 20 bytes of second word
  const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
  if (data.length < 128) return null;
  const pool = norm("0x" + data.slice(64 + 24, 128));
  return { token0, token1, fee, pool };
}

function decodeTransfer(log: EvmLog): {
  from: string;
  to: string;
  value: bigint;
} | null {
  if (log.topics.length < 3) return null;
  const from = topicAddress(log.topics[1]!);
  const to = topicAddress(log.topics[2]!);
  try {
    const value = BigInt(log.data);
    return { from, to, value };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Config / state
// ---------------------------------------------------------------------------
const portalUrl =
  process.env.PORTAL_URL ?? "https://portal.sqd.dev/datasets/robinhood-mainnet";
const apiKey = process.env.SQD_API_KEY ?? process.env.SQD_TOKEN;
const factory = norm(process.env.FACTORY ?? DEFAULT_FACTORY);
const lookback = Math.max(0, Number(process.env.LOOKBACK_BLOCKS ?? 200));
const maxTokens = Math.max(10, Number(process.env.MAX_TOKENS ?? 300));

const tokens = new MintRegistry(maxTokens); // reuse FIFO registry (mint → token)
const wallets = new Set<string>();
const store = new BalanceStore(48);

// token → { other, fee, pool }
const tokenInfo = new Map<
  string,
  { pairWith: string; fee: number; pool: string; block: number }
>();

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------
function buildQuery(from: number): EvmPortalQuery {
  const tokenList = tokens.values();
  const logs: any[] = [
    {
      address: [factory],
      topic0: [POOL_CREATED_TOPIC],
    },
  ];

  // Transfer events for watched tokens
  if (tokenList.length > 0) {
    logs.push({
      address: tokenList,
      topic0: [TRANSFER_TOPIC],
    });
  }

  // Also catch transfers where a watched wallet is from/to via topic filter
  // (Portal may support topic1/topic2 arrays — if not, we rely on address filter above)
  // For wallet tracking we filter client-side on Transfer logs of watched tokens,
  // and additionally request any Transfer involving watched wallets if supported.
  // Conservative: only token-address filter; wallet activity appears when it touches watched tokens.

  return {
    type: "evm",
    fromBlock: from,
    fields: {
      block: {
        number: true,
        hash: true,
        parentHash: true,
        timestamp: true,
      },
      log: {
        address: true,
        topics: true,
        data: true,
        transactionHash: true,
        logIndex: true,
        transactionIndex: true,
      },
    },
    logs,
  };
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------
function startControl() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  rl.on("line", (line) => {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    const cmd = (parts[0] ?? "").toLowerCase();
    const arg = (parts[1] ?? "").toLowerCase();

    switch (cmd) {
      case "help":
      case "?":
        console.log(`
commands:
  status
  tokens
  wallets
  drop <token>
  dropall
  watch <wallet>
  unwatch <wallet>
  help
`);
        break;
      case "status":
        console.log(
          `[status] tokens=${tokens.size}/${maxTokens} wallets=${wallets.size} balances=${store.size}`,
        );
        break;
      case "tokens":
        if (tokens.size === 0) console.log("(none)");
        else {
          for (const { mint, meta } of tokens.list()) {
            const info = tokenInfo.get(mint);
            console.log(
              `  ${mint}  $${meta.symbol}  pair=${info?.pairWith.slice(0, 10) ?? "?"}… fee=${info?.fee ?? "?"} pool=${info?.pool.slice(0, 10) ?? "?"}…`,
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
          console.log("usage: drop <token>");
          break;
        }
        if (tokens.delete(arg)) {
          store.deletePrefix(`t:${arg}:`);
          tokenInfo.delete(arg);
          console.log(`[ctrl] dropped ${arg.slice(0, 12)}…`);
        } else console.log(`[ctrl] not watched`);
        break;
      case "dropall":
        tokens.clear();
        tokenInfo.clear();
        store.deletePrefix("t:");
        console.log("[ctrl] dropped all tokens");
        break;
      case "watch":
        if (!arg || arg.length < 40) {
          console.log("usage: watch <wallet>");
          break;
        }
        wallets.add(norm(arg));
        console.log(`[ctrl] watch ${arg.slice(0, 12)}… (${wallets.size})`);
        break;
      case "unwatch":
        if (!arg) {
          console.log("usage: unwatch <wallet>");
          break;
        }
        if (wallets.delete(norm(arg))) {
          store.deletePrefix(`w:${norm(arg)}:`);
          console.log(`[ctrl] unwatch ${arg.slice(0, 12)}…`);
        } else console.log(`[ctrl] not watched`);
        break;
      case "":
        break;
      default:
        console.log(`unknown: ${cmd}`);
    }
  });
  rl.on("close", () => {});
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!apiKey) {
    console.warn(
      "[rh] warning: SQD_API_KEY not set — private Robinhood dataset will likely 401",
    );
  }

  console.log(`[rh] portal=${portalUrl}`);
  console.log(`[rh] factory=${factory}`);

  const head = await getEvmHead(portalUrl, apiKey);
  const from = Math.max(0, head.number - lookback);

  console.log(
    `[rh] from=${from} head=${head.number} lookback=${lookback} maxTokens=${maxTokens}`,
  );
  console.log(`[rh] type "help" for commands`);
  startControl();

  let lastProgress = 0;

  await runEvmPortal({
    portalUrl,
    apiKey,
    from,
    buildQuery: (cursor) => buildQuery(cursor),
    onBlock: async (block: EvmPortalBlock) => {
      const slot = block.header.number;
      const logs = block.logs ?? [];
      const touched: string[] = [];

      // ----- PoolCreated -----
      for (const log of logs) {
        if (norm(log.address) !== factory) continue;
        if (log.topics[0]?.toLowerCase() !== POOL_CREATED_TOPIC) continue;

        const parsed = decodePoolCreated(log);
        if (!parsed) continue;

        const { token0, token1, fee, pool } = parsed;
        const tx = log.transactionHash ?? "?";

        for (const [token, other] of [
          [token0, token1],
          [token1, token0],
        ] as const) {
          if (tokens.has(token)) continue;
          const evicted = tokens.add(token, {
            name: token.slice(0, 10),
            symbol: token.slice(2, 8).toUpperCase(),
            slot,
          });
          for (const e of evicted) {
            store.deletePrefix(`t:${e}:`);
            tokenInfo.delete(e);
            console.log(`[rh] evicted ${e.slice(0, 12)}…`);
          }
          tokenInfo.set(token, { pairWith: other, fee, pool, block: slot });
          console.log(
            `\n🚀 NEW POOL token=${token}` +
              `\n   pair   ${other}` +
              `\n   fee    ${fee}` +
              `\n   pool   ${pool}` +
              `\n   tx     ${tx}` +
              `\n   block  ${slot}` +
              `\n   tokens ${tokens.size}/${maxTokens}`,
          );
        }
      }

      // ----- Transfers -----
      for (const log of logs) {
        if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
        const token = norm(log.address);
        if (!tokens.has(token)) continue;

        const t = decodeTransfer(log);
        if (!t) continue;
        const tx = log.transactionHash ?? "?";

        // Holder view: both from and to
        for (const [owner, sign] of [
          [t.from, -1n],
          [t.to, 1n],
        ] as const) {
          if (owner === ZERO) continue; // mint/burn edge reflected on the other side

          const key = `t:${token}:${owner}`;
          // For Transfer we only have the delta on one side; synthesize pre/post-style
          const delta = t.value * sign;
          const stored = store["balances"].get(key);
          const prev = stored ?? 0n;
          // If first sight and this is a receive, treat as NEW from 0
          const preSum = sign > 0n ? (stored ?? 0n) : (stored ?? t.value);
          const postSum = preSum + delta;
          const result = store.applyObserved(
            key,
            preSum,
            postSum < 0n ? 0n : postSum,
          );
          if (!result) continue;
          touched.push(key);

          const event = classify(result.prev, result.next);
          const info = tokenInfo.get(token);
          console.log(
            `\n[holder] ${event.padEnd(8)} ${token.slice(0, 10)}…  ` +
              `owner=${owner.slice(0, 10)}…  ` +
              `δ=${(result.next - result.prev).toString().padStart(14)}  ` +
              `bal=${result.next.toString().padStart(14)}  ` +
              `block=${slot}  ${tx.slice(0, 14)}…` +
              (info ? ` fee=${info.fee}` : ""),
          );

          // Wallet view
          if (wallets.has(owner)) {
            const wkey = `w:${owner}:${token}`;
            const wr = store.applyObserved(
              wkey,
              preSum,
              postSum < 0n ? 0n : postSum,
            );
            if (wr) {
              touched.push(wkey);
              const we = classify(wr.prev, wr.next);
              console.log(
                `\n[wallet] ${we.padEnd(8)} wallet=${owner.slice(0, 10)}…  ` +
                  `token=${token.slice(0, 10)}…  ` +
                  `δ=${(wr.next - wr.prev).toString().padStart(14)}  ` +
                  `bal=${wr.next.toString().padStart(14)}  ` +
                  `block=${slot}`,
              );
            }
          }
        }
      }

      store.commitBlock(
        slot,
        block.header.hash,
        block.header.parentHash,
        touched,
      );

      if (slot - lastProgress >= 40) {
        process.stderr.write(
          `\x1b[2K\r[rh] block=${slot} tokens=${tokens.size} wallets=${wallets.size}   `,
        );
        lastProgress = slot;
      }
    },
  });
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[rh] fatal", err);
    process.exitCode = 1;
  });
}
