import { expect, test } from "bun:test";
import { holderKind, holderVeto, type TopHolder } from "./top-holders.ts";

const h = (pct: number, kind: TopHolder["kind"], owner = "wallet" + pct): TopHolder => ({ pct, kind, owner });
test("account owners classify holders", () => {
  expect(holderKind("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA")).toBe("pool");
  expect(holderKind("11111111111111111111111111111111")).toBe("wallet");
  expect(holderKind(null)).toBe("wallet");
  expect(holderKind("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")).toBe("lock");
});
test("a plain wallet with a huge share is refused (AXrB1a: 76%)", () => {
  expect(holderVeto([h(76, "wallet"), h(21.6, "pool"), h(0.1, "wallet")])).toContain("76%");
});
test("locked supply and the pool do not count (AJJjNs: 69.7% locked)", () => {
  expect(holderVeto([h(69.7, "lock"), h(18, "pool"), h(1.3, "wallet"), h(1.1, "wallet")])).toBeNull();
});
test("many mid wallets add up", () => {
  expect(holderVeto(Array.from({ length: 6 }, (_, i) => h(8, "wallet", `w${i}`)))).toContain("48%");
});
test("a wallet that built its position later is not a bundle (PIKA)", () => {
  expect(holderVeto([h(20, "wallet", "trader")], new Set(), () => false)).toBeNull();
  expect(holderVeto([h(76, "wallet", "bundler")], new Set(), o => o === "bundler")).toContain("76%");
});
test("any wallet over 40% is refused, however it got there", () => {
  expect(holderVeto([h(76, "wallet", "late")], new Set(), () => false)).toContain("76%");
  expect(holderVeto([h(30, "wallet", "late")], new Set(), () => false)).toBeNull();
});
test("relay wallets are not holders", () => {
  expect(holderVeto([h(30, "wallet", "relay")], new Set(["relay"]))).toBeNull();
});
