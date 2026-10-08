import { test, expect } from "bun:test";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { JupiterVenue } from "./jupiter-venue.ts";
import { SOL_ASSET, rawAmount } from "../core/amounts.ts";
test("Jupiter instruction routes protect exact input and output, omit provider compute budget and retain ALTs", async () => {
  const mint = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  const calls: Array<{ path: string; body?: any }> = [];
  const transport = (async (url: string, init: RequestInit) => {
    calls.push({
      path: url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("quote"))
      return Response.json({
        inputMint: parsed.searchParams.get("inputMint"),
        outputMint: parsed.searchParams.get("outputMint"),
        inAmount: parsed.searchParams.get("amount"),
        outAmount: "1000",
        otherAmountThreshold: "950",
        swapMode: "ExactIn",
        slippageBps: 500,
        routePlan: [{ swapInfo: { label: "Raydium" } }],
      });
    return Response.json({
      swapInstruction: {
        programId: SystemProgram.programId.toBase58(),
        accounts: [
          { pubkey: user.toBase58(), isSigner: true, isWritable: true },
        ],
        data: "AA==",
      },
      computeBudgetInstructions: [{ invalid: true }],
      addressLookupTableAddresses: [mint.toBase58()],
    });
  }) as typeof fetch;
  const venue = new JupiterVenue(transport);
  const market = {
    mint,
    venue: "jupiter",
    quoteAsset: SOL_ASSET,
    creator: null,
    metadata: {},
    baseTokenProgram: SOL_ASSET.tokenProgram,
  };
  const ctx = { user, token: { mint: mint.toBase58() }, connection: {} } as any;
  const buy = await venue.quoteBuy(
    ctx,
    market,
    rawAmount(1_000_000n, SOL_ASSET),
    500,
  );
  const built = await venue.buildBuy(ctx, market, buy);
  expect(built.minOutputRaw).toBe(950n);
  expect(built.instructions).toHaveLength(1);
  expect(built.meta?.lookupTableAddresses).toEqual([mint.toBase58()]);
  expect(calls[1]!.body.dynamicComputeUnitLimit).toBe(false);
  const sell = await venue.quoteSell(ctx, market, 10n, 500);
  expect(sell.inputRaw).toBe(10n);
  expect(sell.minimumOutputRaw).toBe(950n);
  expect(new URL(calls[2]!.path).searchParams.get("outputMint")).toBe(
    SOL_ASSET.mint.toBase58(),
  );
});
test("unprotected or mismatched Jupiter quote fails before instruction request", async () => {
  let calls = 0;
  const venue = new JupiterVenue((async () => {
    calls++;
    return Response.json({
      inAmount: "1",
      outAmount: "1000",
      otherAmountThreshold: "1",
      swapMode: "ExactIn",
      routePlan: [{}],
    });
  }) as unknown as typeof fetch);
  const mint = Keypair.generate().publicKey;
  await expect(
    venue.quoteSell({} as any, { mint } as any, 1n, 500),
  ).rejects.toMatchObject({ code: "NO_ROUTE" });
  expect(calls).toBe(1);
});
