import { expect, test } from "bun:test";
import { BlockhashCache } from "./blockhash.ts";
import type { Connection } from "@solana/web3.js";
const hash = (n: number) => ({ blockhash: String(n), lastValidBlockHeight: n });

test("concurrent blockhash calls coalesce and different connections stay isolated", async () => {
  let calls = 0;
  let resolve!: (value: ReturnType<typeof hash>) => void;
  const connection = {
    getLatestBlockhash: () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
  } as unknown as Connection;
  const cache = new BlockhashCache();
  const first = cache.get(connection);
  const second = cache.get(connection);
  await Promise.resolve();
  expect(calls).toBe(1);
  resolve(hash(1));
  expect(await first).toEqual(hash(1));
  expect(await second).toEqual(hash(1));
  await cache.get(connection);
  expect(calls).toBe(1);
  const other = {
    getLatestBlockhash: async () => hash(2),
  } as unknown as Connection;
  expect(await cache.get(other)).toEqual(hash(2));
});

test("invalidation prevents an older in-flight response from replacing fresh state", async () => {
  const resolves: Array<(value: ReturnType<typeof hash>) => void> = [];
  const connection = {
    getLatestBlockhash: () => new Promise((r) => resolves.push(r as any)),
  } as unknown as Connection;
  const cache = new BlockhashCache();
  const old = cache.get(connection);
  await Promise.resolve();
  cache.invalidate();
  const fresh = cache.get(connection);
  await Promise.resolve();
  expect(resolves).toHaveLength(2);
  resolves[1]!(hash(2));
  await fresh;
  resolves[0]!(hash(1));
  await old;
  expect(await cache.get(connection)).toEqual(hash(2));
});

test("background warming refreshes independently of TTL and stop cancels future reads", async () => {
  let calls = 0;
  const connection = {
    getLatestBlockhash: async () => hash(++calls),
  } as unknown as Connection;
  const cache = new BlockhashCache(10000);
  const warmer = cache.start(connection, { intervalMs: 5 });
  await Bun.sleep(20);
  warmer.stop();
  expect(calls).toBeGreaterThan(1);
  const stoppedCalls = calls;
  await Bun.sleep(15);
  expect(calls).toBe(stoppedCalls);
  expect(await cache.get(connection)).toEqual(hash(stoppedCalls));
});

test("failed background reads do not poison subsequent foreground calls", async () => {
  let calls = 0;
  const connection = {
    getLatestBlockhash: async () => {
      if (++calls === 1) throw new Error("offline");
      return hash(calls);
    },
  } as unknown as Connection;
  const cache = new BlockhashCache();
  const warmer = cache.start(connection, { intervalMs: 10000 });
  await Bun.sleep(1);
  warmer.stop();
  expect(await cache.get(connection)).toEqual(hash(2));
});
