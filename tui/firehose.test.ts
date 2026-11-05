import { expect, test } from "bun:test";
import { ammPriceAfter } from "./firehose.ts";

// A real CttHJa sell: the event's reserves equal the vaults before the transaction, not after it.
const sell = { side: "sell" as const, poolBaseRaw: 409547702845705n, poolQuoteRaw: 28018398576n, virtualQuoteRaw: 17583182217n };
const after = (28018398576 - 63625415 + 17583182217) / (409547702845705 + 572332741445);

test("a sell moves the price down from the event's reserves", () => {
  const p = ammPriceAfter({ ...sell, baseRaw: 572332741445n, quoteRaw: 63625415n });
  expect(p).toBeCloseTo(after, 12);
  expect(p).toBeLessThan((28018398576 + 17583182217) / 409547702845705);
});
test("a buy moves it up", () => {
  const before = 45_000_000_000 / 400_000_000_000_000;
  expect(ammPriceAfter({ side: "buy", baseRaw: 1_000_000_000_000n, quoteRaw: 110_000_000n, poolBaseRaw: 400_000_000_000_000n, poolQuoteRaw: 45_000_000_000n })).toBeGreaterThan(before);
});
test("no virtual reserve still prices", () => {
  expect(ammPriceAfter({ side: "buy", baseRaw: 10n, quoteRaw: 5n, poolBaseRaw: 100n, poolQuoteRaw: 50n, virtualQuoteRaw: null })).toBeCloseTo(55 / 90);
});
test("a trade that would empty the pool gives no price", () => {
  expect(ammPriceAfter({ side: "buy", baseRaw: 100n, quoteRaw: 5n, poolBaseRaw: 100n, poolQuoteRaw: 50n })).toBeNaN();
});
