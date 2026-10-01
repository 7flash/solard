#!/usr/bin/env bun
import slrd from "@solard/sdk";

const walletName = process.argv[2] ?? "agent-1";
const token = process.argv[3];
const moreToken = process.argv[4];
if (!token)
  throw new Error("Usage: bun examples/sdk-api.ts <wallet-name> <token-mint>");

let wallet;
try {
  wallet = slrd.createWallet(walletName);
} catch {
  wallet = { address: slrd.walletAddress(walletName) };
}

console.log({ wallet: wallet.address });

const listener = await slrd.listenTrades({ tokens: [token] });
listener.onTrade((trade) => {
  console.log({
    token: trade.mint,
    direction: trade.side,
    amountRaw: trade.baseRaw?.toString() ?? null,
    signature: trade.signature,
    priceSol: trade.market.priceSol,
    priceUsd: trade.market.priceUsd,
  });
});

const buy = await slrd.buy({
  wallet: walletName,
  token,
  amount: 0.01,
  slippageBps: 500,
});
console.log({ buy });

const transaction = await slrd.getTransaction(buy.signature);
console.log({ transaction });

if (moreToken) await listener.add(moreToken);

const sell = await slrd.sell({
  wallet: walletName,
  token,
  amount: "all",
  slippageBps: 500,
});
console.log({ sell });

await listener.close();
slrd.close();
