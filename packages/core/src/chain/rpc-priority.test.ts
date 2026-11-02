import { expect, test } from "bun:test";
import { RpcTradePriority } from "./rpc-priority.ts";
test("trade priority reserves admission opportunity without starving background or increasing quotas", () => {
  const p = new RpcTradePriority();
  expect(p.delay(false, 0)).toBe(0);
  p.active = 1;
  expect(p.delay(false, 0)).toBe(0);
  expect(p.delay(false, 1)).toBe(1099);
  expect(p.delay(true, 1)).toBe(0);
  expect(p.delay(false, 1100)).toBe(0);
  p.active = 0;
  expect(p.delay(false, 1101)).toBe(0);
});
