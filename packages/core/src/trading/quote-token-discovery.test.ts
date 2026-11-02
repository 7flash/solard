import { expect, test } from "bun:test";
import { discoverConversionToken } from "./quote-token-discovery.ts";
import type { TokenRow } from "../db/schema.ts";
test("external quote skips unrelated discovery only after native absence; verified native routes need no key", async () => {
  let scans = 0; const registered: unknown[] = [];
  const base = { existing: () => null, curve: async () => null, solPool: async () => null,
    register: async (meta: unknown) => { registered.push(meta); return meta as TokenRow; },
    fallback: async () => { scans++; return { venueHint: "pumpswap" } as TokenRow; }, jupiterAvailable: true };
  expect((await discoverConversionToken(base)).venueHint).toBe("jupiter"); expect(scans).toBe(0);
  expect((await discoverConversionToken({ ...base, jupiterAvailable: false, curve: async () => ({ venueHint: "pump-curve" }) })).venueHint).toBe("pump-curve");
  expect((await discoverConversionToken({ ...base, jupiterAvailable: false, solPool: async () => ({ venueHint: "pumpswap" }) })).venueHint).toBe("pumpswap");
  await discoverConversionToken({ ...base, jupiterAvailable: false }); expect(scans).toBe(1);
});
test("provider failures do not turn into missing routes or overwrite explicit identity", async () => {
  let writes = 0;
  const base = { existing: () => null, curve: async () => { throw Error("RPC_PROVIDER_UNAVAILABLE"); }, solPool: async () => null,
    register: async () => { writes++; return {} as TokenRow; }, fallback: async () => ({} as TokenRow), jupiterAvailable: true };
  await expect(discoverConversionToken(base)).rejects.toThrow("RPC_PROVIDER_UNAVAILABLE"); expect(writes).toBe(0);
  const explicit = { venueHint: "jupiter" } as TokenRow;
  expect(await discoverConversionToken({ ...base, existing: () => explicit })).toBe(explicit);
});
