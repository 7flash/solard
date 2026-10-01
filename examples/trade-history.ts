#!/usr/bin/env bun
import slrd from "@solard/sdk";

const wallet = process.argv[2]?.trim();
const token = process.argv[3]?.trim();

if (!wallet || !token) {
  throw new Error("Usage: bun examples/trade-history.ts <wallet> <token-mint>");
}

const trades = await slrd.trades({
  wallet,
  token,
  status: "confirmed",
});

process.stdout.write(
  `${JSON.stringify(
    trades,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  )}\n`,
);

slrd.close();
