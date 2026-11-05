import { expect, test } from "bun:test";
import { ChainPrices } from "./chain-prices.ts";

const MINT = "So11111111111111111111111111111111111111112";
function reader(needs: boolean, recheckMs = 60_000) {
  const reads: number[] = [];
  const connection = { getMultipleAccountsInfo: async (keys: unknown[]) => { reads.push(keys.length); return keys.map(() => null); } };
  const c = new ChainPrices({ connection: connection as never, log: () => {}, intervalMs: 1e9, needs: () => needs, recheckMs, resolve: mint => ({ mint, venueHint: "pump-curve" }) });
  c.add(MINT);
  return { round: () => (c as unknown as { round(): Promise<void> }).round(), reads, c };
}

test("first round reads every coin once", async () => {
  const r = reader(false); await r.round();
  expect(r.reads).toEqual([1]); r.c.remove(MINT);
});
test("a healthy stream costs no RPC after that", async () => {
  const r = reader(false); await r.round(); await r.round(); await r.round();
  expect(r.reads).toEqual([1]); r.c.remove(MINT);
});
test("a coin gone for good is not read every round", async () => {
  const r = reader(true); await r.round(); await r.round(); // accounts come back null: "curve account missing"
  expect(r.reads).toEqual([1]); r.c.remove(MINT);
});
test("the cross-check reads every coin after recheckMs", async () => {
  const r = reader(false, 0); await r.round(); await r.round();
  expect(r.reads).toEqual([1, 1]); r.c.remove(MINT);
});
