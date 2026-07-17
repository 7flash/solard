// Canonical Robinhood stock-token issuance and transfer listener.
// Uses SQD EVM Portal directly; no @subsquid package.

import {
  decodeTransfer,
  formatUnitsExact,
  shortAddress,
  TRANSFER_TOPIC,
  ZERO_ADDRESS,
} from "./shared/evm.ts";
import { fetchPortalHead, runPortal, type EvmQuery } from "./shared/portal.ts";
import { resolveTokens, TOKEN_BY_ADDRESS } from "./shared/tokens.ts";

function numberFlag(flag: string): number | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${flag} requires a block number`);
  return value;
}

const tokens = resolveTokens(process.argv.slice(2), true);
if (tokens.length === 0)
  throw new Error("provide token symbols/addresses or --canonical");
const addresses = tokens.map((token) => token.address);
const fromArg = numberFlag("--from");
const toArg = numberFlag("--to");
const finalized = process.env.SQD_FINALIZED !== "0";
const head = await fetchPortalHead(undefined, finalized);
const lookback = Number(process.env.RH_LIVE_LOOKBACK ?? 10_000);
const from = fromArg ?? Math.max(0, head.number - lookback);

function buildQuery(cursor: number): EvmQuery {
  return {
    type: "evm",
    fromBlock: cursor,
    fields: {
      block: { number: true, hash: true, parentHash: true, timestamp: true },
      log: {
        address: true,
        topics: true,
        data: true,
        transactionHash: true,
        transactionIndex: true,
        logIndex: true,
      },
    },
    logs: [{ address: addresses, topic0: [TRANSFER_TOPIC] }],
  };
}

console.log(
  `[rh:stocks] ${tokens.length} contracts from block ${from}${toArg === undefined ? "" : ` to ${toArg}`}`,
);

await runPortal({
  name: "rh-stocks",
  finalized,
  from,
  ...(toArg === undefined ? {} : { to: toArg }),
  buildQuery,
  onBlock: async (block) => {
    for (const log of block.logs ?? []) {
      const transfer = decodeTransfer(log);
      if (!transfer) continue;
      const token = TOKEN_BY_ADDRESS.get(transfer.token);
      const symbol = token?.symbol ?? shortAddress(transfer.token);
      const decimals = token?.decimals ?? 18;
      const kind =
        transfer.from === ZERO_ADDRESS
          ? "MINT"
          : transfer.to === ZERO_ADDRESS
            ? "BURN"
            : "TRANSFER";
      console.log(
        `[rh:stocks] ${kind.padEnd(8)} ${symbol.padEnd(5)} ` +
          `${formatUnitsExact(transfer.amount, decimals)} ` +
          `${shortAddress(transfer.from)} → ${shortAddress(transfer.to)} ` +
          `block=${block.header.number} tx=${shortAddress(transfer.transactionHash)}`,
      );
    }
  },
});
