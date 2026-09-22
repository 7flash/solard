import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(import.meta.dir, "position-controller.ts"),
  "utf8",
);

function functionBody(name: string, next: string): string {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`async function ${next}`, start + 1);
  if (start < 0 || end < 0) throw new Error(`missing ${name}/${next}`);
  return source.slice(start, end);
}

describe("position controller native sizing", () => {
  test("final sizeToBase evaluation keeps slrd and walletRef", () => {
    const body = functionBody("sizeToBase", "runValueBandAgent");
    const calls = [
      ...body.matchAll(/futureLiquidationForBuy\(\{([\s\S]*?)\n\s*\}\);/g),
    ];
    expect(calls.length).toBeGreaterThanOrEqual(2);

    for (const call of calls) {
      expect(call[1]).toContain("slrd: args.slrd");
      expect(call[1]).toContain("walletRef: args.walletRef");
      expect(call[1]).toContain("raydium: args.raydium");
      expect(call[1]).toContain("mint: args.mint");
    }
  });

  test("auto falls back to Raydium only for UNSUPPORTED_TOKEN", () => {
    const body = functionBody("quoteBestRoute", "executeRoutedSwap");
    expect(body).toContain('errorCode(nativeError) !== "UNSUPPORTED_TOKEN"');
    expect(body).toContain("Refusing external fallback");
    expect(body).toContain("native=UNSUPPORTED_TOKEN");
  });

  test("Jupiter remains explicit-only", () => {
    const body = functionBody("quoteBestRoute", "executeRoutedSwap");
    expect(body).toContain(
      'if (args.mode === "jupiter") return await quoteJupiter()',
    );
    expect(body).not.toContain("Promise.allSettled");
  });
});
