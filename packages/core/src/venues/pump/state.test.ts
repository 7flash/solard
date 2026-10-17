import { test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { decodeCurve, PUMP_CURVE_DISCRIMINATOR } from "./state.ts";
import type { TokenRow } from "../../db/schema.ts";
test("curve metadata rejects a different account discriminator and truncated layout", () => {
  const data = Buffer.alloc(115);
  const token = { mint: PublicKey.default.toBase58() } as TokenRow;
  expect(() => decodeCurve(PublicKey.default, data, token)).toThrow("invalid account discriminator");
  PUMP_CURVE_DISCRIMINATOR.copy(data);
  expect(decodeCurve(PublicKey.default, data, token).quoteAsset.kind).toBe("native-sol");
  expect(() => decodeCurve(PublicKey.default, data.subarray(0, 48), token)).toThrow("too short");
});
