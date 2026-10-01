import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const manager = readFileSync(
  join(import.meta.dir, "trader-manager-server.ts"),
  "utf8",
);
const client = readFileSync(
  join(import.meta.dir, "../packages/sdk/src/client.ts"),
  "utf8",
);

describe("mements solard boundary", () => {
  test("manager exposes Solard-owned ledger reads", () => {
    expect(manager).toContain('import slrd from "@solard/sdk"');
    expect(manager).toContain('url.pathname === "/ledger/trades"');
    expect(manager).toContain('url.pathname === "/ledger/position"');
    expect(manager).toContain("await slrd.trades({");
    expect(manager).toContain("await slrd.position({");
  });

  test("manager owns no database", () => {
    expect(manager).not.toMatch(/sqlite-zod-orm|better-sqlite|Database\(/);
    expect(manager).not.toMatch(/from ["'][^"']*\/db(?:\.|\/)/);
  });

  test("sdk exposes both trade history and current position", () => {
    expect(client).toContain("trades(options?: SolardTradeQuery)");
    expect(client).toContain("position(options: SolardPositionQuery)");
    expect(client).toContain("position: core.position.bind(core)");
  });
});
