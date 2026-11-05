import { expect, test } from "bun:test";
import { closedRows } from "./closed-positions.ts";

const fills = [{ atMs: 10, side: "buy" as const, sol: 0.1 }, { atMs: 20, side: "sell" as const, sol: 0.05 }, { atMs: 40, side: "buy" as const, sol: 0.2 }];
const row = (at: number, pnlSol: number, mint = "m") => ({ at, wallet: "w", mint, pnlSol });

test("newest first with spent, trades and percent", () => {
  const r = closedRows([row(30, 0.05), row(50, -0.1, "n")], x => x.mint === "m" ? fills : [], m => m.toUpperCase());
  expect(r.map(x => x.mint)).toEqual(["n", "m"]);
  expect(r[1]).toMatchObject({ symbol: "M", openedAt: 10, boughtSol: 0.1, buys: 1, sells: 1, pct: 50 });
});
test("a coin closed twice splits its fills", () => {
  const r = closedRows([row(30, 0.05), row(50, 0.02)], () => fills, () => null);
  expect(r[0]).toMatchObject({ boughtSol: 0.2, buys: 1, sells: 0, openedAt: 40 });
  expect(r[1]).toMatchObject({ boughtSol: 0.1, buys: 1, sells: 1 });
});
test("no log still shows the result", () => {
  expect(closedRows([row(30, -0.01)], () => [], () => null)[0]).toMatchObject({ pnlSol: -0.01, boughtSol: 0, pct: null, openedAt: null });
});
test("the list stops at the limit", () => {
  expect(closedRows([row(1, 0), row(2, 0), row(3, 0)], () => [], () => null, 2).map(x => x.closedAt)).toEqual([3, 2]);
});
