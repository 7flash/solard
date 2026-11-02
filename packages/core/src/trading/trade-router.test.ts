import { expect, test } from "bun:test";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { resolveTradeRoute } from "./trade-router.ts";
import type { Solard } from "../core/solard.ts";
import type { TokenRow } from "../db/schema.ts";

const mint = "CSocnzcRpgSCr1naKcNTieWZUxb6rABe45j844m7pump";
function fixture(hint: string | null) {
  const row = { mint, decimals: 6, baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(), venueHint: hint } as TokenRow;
  let inspections = 0;
  const host = {
    tokens: { list: () => [row] },
    refreshToken: async () => { inspections++; return { ...row, venueHint: "pumpswap" }; },
  } as unknown as Solard;
  return { host, row, inspections: () => inspections };
}
test("unknown cached Pump mint is discovered before selecting Jupiter", async () => {
  const f = fixture("unknown");
  const result = await resolveTradeRoute(f.host, mint);
  expect(result.route).toBe("native");
  expect(result.token?.venueHint).toBe("pumpswap");
  expect(f.inspections()).toBe(1);
});
test("explicit Jupiter and known native routes do not trigger discovery", async () => {
  const unknown = fixture("unknown");
  expect((await resolveTradeRoute(unknown.host, mint, "jupiter")).route).toBe("jupiter");
  expect(unknown.inspections()).toBe(0);
  const native = fixture("pump-curve");
  expect((await resolveTradeRoute(native.host, mint)).route).toBe("native");
  expect(native.inspections()).toBe(0);
});
test("provider failure during discovery is not converted into Jupiter fallback", async () => {
  const f = fixture("unknown");
  f.host.refreshToken = async () => { throw Object.assign(new Error("Provider unavailable"), { code: "RPC_PROVIDER_UNAVAILABLE" }); };
  await expect(resolveTradeRoute(f.host, mint)).rejects.toMatchObject({ code: "RPC_PROVIDER_UNAVAILABLE" });
});
test("uncached mint is inspected and registered before selecting a native route", async () => {
  let discovered = 0;
  const host = {
    tokens: { list: () => [] },
    connection: () => ({}),
    cache: { get: async (key: string) => key.startsWith("mint-owner:")
      ? TOKEN_PROGRAM_ID : { decimals: 6, supply: 1_000_000n } },
    resolveTokenForExecution: async (value: string) => {
      expect(value).toBe(mint); discovered++;
      return { mint, decimals: 6, baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(), venueHint: "pump-curve" };
    },
  } as unknown as Solard;
  expect((await resolveTradeRoute(host, mint)).route).toBe("native");
  expect(discovered).toBe(1);
});
test("verified absence of a native market still permits Jupiter fallback", async () => {
  const f = fixture("unknown");
  f.host.refreshToken = async () => f.row;
  expect((await resolveTradeRoute(f.host, mint)).route).toBe("jupiter");
});
