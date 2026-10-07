import { expect, test } from "bun:test";
import { PublicKey, SystemProgram, type Connection } from "@solana/web3.js";
import { SOL_ASSET } from "../core/amounts.ts";
import { defaultPumpQuoteShell } from "../venues/pump/common.ts";
import { batchCreatorFeePlans, getClaimableCreatorFees } from "./creator-fees.ts";
import type { ClaimPlan, ClaimSourcePlugin } from "./claim-source.ts";

const wallet = PublicKey.default;
const plan = (): ClaimPlan => ({ source: "fixture", quoteAsset: SOL_ASSET, estimatedClaimRaw: 100n,
  spendableByUserRaw: 100n, instructions: [SystemProgram.transfer({ fromPubkey: wallet, toPubkey: SOL_ASSET.mint, lamports: 1 })],
  meta: { attribution: "shared-creator-vault", claimComponents: [{ key: "shared-vault", amountRaw: "100", spendableRaw: "100" }] } });

test("shared creator vault amounts and identical claim instructions are counted once", async () => {
  const tokens = [defaultPumpQuoteShell(wallet), defaultPumpQuoteShell(SOL_ASSET.mint)];
  const source: ClaimSourcePlugin = { id: "fixture", async resolveClaim() { return plan(); } };
  const result = await getClaimableCreatorFees({} as Connection, wallet, tokens, [source]);
  expect(result.items.map((item) => item.status)).toEqual(["claimable", "claimable"]);
  expect(result.groups).toHaveLength(1);
  expect(result.groups[0]).toMatchObject({ amountRaw: 100n, spendableRaw: 100n, relatedMints: tokens.map((token) => token.mint), attribution: "shared-creator-vault" });
  expect(result.plans.flatMap((value) => value.instructions)).toHaveLength(1);
});

test("unsupported venues and RPC errors retain explicit coverage", async () => {
  const token = defaultPumpQuoteShell(wallet);
  expect((await getClaimableCreatorFees({} as Connection, wallet, [token], [])).items[0]?.status).toBe("unsupported");
  const broken: ClaimSourcePlugin = { id: "broken", async resolveClaim() { throw new Error("RPC unavailable"); } };
  expect((await getClaimableCreatorFees({} as Connection, wallet, [token], [broken])).items[0]).toMatchObject({ status: "error", message: "RPC unavailable" });
});

test("claim batches bound instruction count and reject an indivisible oversized claim", () => {
  expect(batchCreatorFeePlans([plan(), plan(), plan()], 2).map((batch) => batch.length)).toEqual([2, 1]);
  expect(() => batchCreatorFeePlans([{ ...plan(), instructions: [plan().instructions[0]!, plan().instructions[0]!] }], 1)).toThrow("exceeds");
});

test("migration discovery includes multiple claim platforms and survives one unavailable source", async () => {
  const token = defaultPumpQuoteShell(wallet);
  const sources: Array<ClaimSourcePlugin> = [
    { id: "broken", async resolveClaim() { throw new Error("quota exceeded"); } },
    { id: "first", async resolveClaim() { return plan(); } },
    { id: "second", async resolveClaim() { return { ...plan(), source: "second", meta: { claimComponents: [{ key: "second-vault", amountRaw: "50", spendableRaw: "50" }] } }; } },
  ];
  const result = await getClaimableCreatorFees({} as Connection, wallet, [token], sources);
  expect(result.groups.map((group) => group.amountRaw)).toEqual([100n, 50n]);
  expect(result.items.map((item) => item.status)).toEqual(["error", "claimable", "claimable"]);
});
