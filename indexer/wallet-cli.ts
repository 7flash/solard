#!/usr/bin/env bun
import {
  listWatchedWallets,
  listWalletSwaps,
  upsertWatchedWallet,
} from "../shared/db.js";

function address(value: string | undefined): string {
  const result = value?.trim() ?? "";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result)) {
    throw new Error("A valid Solana wallet address is required");
  }
  return result;
}

const command = process.argv[2] ?? "list";

if (command === "add") {
  const wallet = address(process.argv[3]);
  const label = process.argv.slice(4).join(" ").trim() || null;
  console.log(
    JSON.stringify(
      upsertWatchedWallet({
        address: wallet,
        label: label ?? undefined,
        enabled: 1,
        backfillEnabled: 1,
        updatedAtMs: Date.now(),
      }),
      null,
      2,
    ),
  );
} else if (command === "enable") {
  const wallet = address(process.argv[3]);
  console.log(
    JSON.stringify(
      upsertWatchedWallet({
        address: wallet,
        enabled: 1,
        updatedAtMs: Date.now(),
      }),
      null,
      2,
    ),
  );
} else if (command === "disable" || command === "remove") {
  const wallet = address(process.argv[3]);
  console.log(
    JSON.stringify(
      upsertWatchedWallet({
        address: wallet,
        enabled: 0,
        updatedAtMs: Date.now(),
      }),
      null,
      2,
    ),
  );
} else if (command === "backfill") {
  const wallet = address(process.argv[3]);
  const enabled = (process.argv[4] ?? "on").toLowerCase() !== "off";
  console.log(
    JSON.stringify(
      upsertWatchedWallet({
        address: wallet,
        backfillEnabled: enabled ? 1 : 0,
        updatedAtMs: Date.now(),
      }),
      null,
      2,
    ),
  );
} else if (command === "trades") {
  const walletArg = process.argv[3];
  const wallet = walletArg && walletArg !== "all" ? address(walletArg) : null;
  const limit = Math.max(
    1,
    Math.min(Number(process.argv[4] ?? 50) || 50, 1_000),
  );
  console.log(
    JSON.stringify(
      listWalletSwaps({
        wallet,
        limit,
      }),
      null,
      2,
    ),
  );
} else if (command === "list") {
  console.log(
    JSON.stringify(
      listWatchedWallets({
        limit: Math.max(
          1,
          Math.min(Number(process.argv[3] ?? 1_000) || 1_000, 50_000),
        ),
      }),
      null,
      2,
    ),
  );
} else {
  console.log(
    [
      "Usage:",
      "  bun indexer/wallet-cli.ts add <wallet> [label]",
      "  bun indexer/wallet-cli.ts enable <wallet>",
      "  bun indexer/wallet-cli.ts disable <wallet>",
      "  bun indexer/wallet-cli.ts backfill <wallet> on|off",
      "  bun indexer/wallet-cli.ts list [limit]",
      "  bun indexer/wallet-cli.ts trades <wallet|all> [limit]",
      "  bun indexer/wallet-main.ts",
    ].join("\n"),
  );
  process.exitCode = 1;
}
