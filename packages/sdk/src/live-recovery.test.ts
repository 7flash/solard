import { expect, spyOn, test } from "bun:test";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import * as core from "@solard/core";
import { subscribeTrades } from "./live.ts";

test("feed verification gates delivery, validates a snapshot, preserves deduplication and cancels queued recovery", async () => {
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send(text: string) { const value = JSON.parse(text);
      if (value.method === "slotSubscribe") queueMicrotask(() => this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify({ id: value.id, result: 1 }) })));
    }
    close() {}
  } as any;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    const method = JSON.parse(String(init?.body)).method;
    return Response.json({ result: method === "getGenesisHash"
      ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
      : { context: { slot: 42 }, value: 0 } });
  }) as typeof fetch);
  const mint = Keypair.generate().publicKey, pool = Keypair.generate().publicKey;
  const poolProgram = Keypair.generate().publicKey;
  let snapshotValid = false, emitted = 0, reads = 0;
  const accounts = spyOn(Connection.prototype, "getAccountInfo").mockImplementation(async address => {
    reads++;
    if (!snapshotValid) return null;
    const data = Buffer.alloc(82);
    if (address.equals(mint)) { data[44] = 6; data.writeBigUInt64LE(1_000_000_000n, 36); }
    else { mint.toBuffer().copy(data); NATIVE_MINT.toBuffer().copy(data, 32); }
    return { executable: false, lamports: 1, owner: address.equals(mint) ? TOKEN_PROGRAM_ID : poolProgram, data };
  });
  let emit!: (event: core.TradeEvent) => Promise<void>;
  const trades = spyOn(core, "subscribeTrades").mockImplementation(async options => {
    emit = options.onTrade as typeof emit;
    const watched = new Set(options.tokens);
    let settle!: () => void;
    const closed = new Promise<void>(resolve => { settle = resolve; });
    return {
      addTokens: async values => { for (const value of typeof values === "string" ? [values] : values) watched.add(value); },
      removeTokens: async values => { for (const value of typeof values === "string" ? [values] : values) watched.delete(value); },
      hasToken: value => watched.has(value), listTokens: () => [...watched],
      close: async () => { watched.clear(); settle(); }, closed,
    };
  });
  let subscription: Awaited<ReturnType<typeof subscribeTrades>> | undefined;
  let clock: ReturnType<typeof spyOn> | undefined;
  const event = (signature: string, atMs = Date.now()) => ({
    type: "trade", mint: mint.toBase58(), signature, venue: "pumpswap", pool: pool.toBase58(),
    side: "buy", slot: 42, atMs, baseRaw: 1n, quoteRaw: 2n,
    metadata: null, market: {
      quoteMint: NATIVE_MINT.toBase58(), baseDecimals: 6, quoteDecimals: 9,
      supplyRaw: 1_000_000_000n, supply: 1000,
      baseReserveRaw: 1n, baseReserve: 0.000001,
      quoteReserveRaw: 2n, quoteReserve: 0.000000002,
      priceQuotePerToken: 0.002, marketCapQuote: 2,
      priceSol: 0.002, marketCapSol: 2, solUsd: null,
      solUsdSource: null, solUsdAtMs: null, priceUsd: null, marketCapUsd: null,
    },
  }) as core.TradeEvent;
  const verify = async ({ connection, tokens, signal }: coreVerification) => {
    expect(signal.aborted).toBe(false);
    expect(tokens).toContain(mint.toBase58());
    const [mintAccount, poolAccount] = await Promise.all([
      connection.getAccountInfo(mint), connection.getAccountInfo(pool),
    ]);
    return !!mintAccount && !!poolAccount && mintAccount.owner.equals(TOKEN_PROGRAM_ID) &&
      mintAccount.data[44] === 6 && mintAccount.data.readBigUInt64LE(36) > 0n &&
      poolAccount.owner.equals(poolProgram) &&
      new PublicKey(poolAccount.data.subarray(0, 32)).equals(mint) &&
      new PublicKey(poolAccount.data.subarray(32, 64)).equals(NATIVE_MINT);
  };
  try {
    // Environment-only/single-endpoint streams expose the same recovery API.
    const oldEndpoint = process.env.RPC_ENDPOINT;
    process.env.RPC_ENDPOINT = "https://recovery-only.example/";
    try { subscription = await subscribeTrades({ source: "rpc", tokens: [mint.toBase58()],
      rpcUrls: [], healthCheckIntervalMs: 1000, onTrade: () => { emitted++; } }); }
    finally { if (oldEndpoint === undefined) delete process.env.RPC_ENDPOINT; else process.env.RPC_ENDPOINT = oldEndpoint; }
    expect(await subscription.verifyAndResume(verify)).toBe(false);
    await emit(event("blocked")); expect(emitted).toBe(0);
    snapshotValid = true;
    expect(await subscription.verifyAndResume(verify)).toBe(true);
    expect(reads).toBe(4);
    await emit(event("accepted")); await emit(event("accepted"));
    await emit(event("old", Date.now() - 31_000));
    expect(emitted).toBe(1);
    const future = Date.now() + 61_000;
    clock = spyOn(Date, "now").mockReturnValue(future);
    expect(subscription.feedVerified).toBe(false);
    await emit(event("after-silence")); expect(emitted).toBe(1);
    expect(await subscription.verifyAndResume(verify)).toBe(true);
    await emit(event("resumed")); expect(emitted).toBe(2);
    clock.mockRestore(); clock = undefined;
    let finish!: (value: boolean) => void;
    const verification = subscription.verifyAndResume(async () => await new Promise<boolean>(resolve => { finish = resolve; }));
    while (!finish) await Bun.sleep(1);
    const added = subscription.addTokens(Keypair.generate().publicKey.toBase58());
    finish(true);
    expect(await verification).toBe(false); await added;
    expect(subscription.feedVerified).toBe(false);
    let queuedRan = false;
    let hangingStarted = false;
    const hanging = subscription.verifyAndResume(async () => {
      hangingStarted = true; return await new Promise<boolean>(() => {});
    });
    const hangingResult = hanging.then(value => ({ value, error: undefined as unknown }),
      error => ({ value: false, error }));
    while (!hangingStarted) await Bun.sleep(1);
    await expect(subscription.verifyAndResume(async () => { queuedRan = true; return true; }, 5))
      .rejects.toThrow("cancelled or timed out");
    expect(queuedRan).toBe(false);
    await subscription.close();
    expect(((await hangingResult).error as Error).message).toContain("cancelled or timed out");
    expect(subscription.feedVerified).toBe(false);
  } finally {
    clock?.mockRestore(); await subscription?.close();
    trades.mockRestore(); accounts.mockRestore(); fetchMock.mockRestore(); globalThis.WebSocket = originalSocket;
  }
});
type coreVerification = Parameters<import("./live.ts").FeedRecoveryVerification>[0];
