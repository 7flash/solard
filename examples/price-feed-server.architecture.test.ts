import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const server = readFileSync(
  join(import.meta.dir, "price-feed-server.ts"),
  "utf8",
);
const demo = readFileSync(join(import.meta.dir, "multi-agent-demo.ts"), "utf8");
const engine = readFileSync(
  join(import.meta.dir, "lib", "interactive-trader-engine.ts"),
  "utf8",
);
const cliFiles = readdirSync(
  join(import.meta.dir, "..", "packages", "cli", "src"),
);

describe("price feed application boundary", () => {
  test("keeps the feed outside Solard packages", () => {
    expect(cliFiles.filter((name) => name.startsWith("price-feed"))).toEqual(
      [],
    );
    expect(server).toContain('from "@solard/sdk"');
    expect(server).toContain("slrd.listenTrades");
    expect(server).not.toContain("packages/cli");
  });

  test("keeps feed consumers in examples", () => {
    expect(demo).toContain('from "./lib/price-feed-client.ts"');
    expect(engine).toContain('from "./price-feed-client.ts"');
    expect(demo).not.toContain("packages/cli/src/price-feed");
    expect(engine).not.toContain("packages/cli/src/price-feed");
  });
});
