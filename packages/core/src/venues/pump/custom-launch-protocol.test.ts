import { expect, test, spyOn } from "bun:test";
import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  OnlinePumpSdk,
  initialVirtualQuoteReservesFor,
  newBondingCurve,
  type Global,
  type QuoteControl,
} from "@pump-fun/pump-sdk";
import { PumpTokenLaunchpad } from "./pump-launchpad.ts";
import type { PreparedTokenDeployment } from "../../launches/launchpad.ts";
import { SOL_ASSET } from "../../core/amounts.ts";

const usdc = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const listed = Keypair.generate().publicKey;
const controlled = Keypair.generate().publicKey;
const unknown = Keypair.generate().publicKey;
const mint = Keypair.generate();
const creator = Keypair.generate().publicKey;
const globalState = {
  initialVirtualTokenReserves: new BN("1073000000000000"),
  initialVirtualSolReserves: new BN("30000000000"),
  initialVirtualQuoteReserves: new BN("321123456"),
  initialRealTokenReserves: new BN("793100000000000"),
  tokenTotalSupply: new BN("1000000000000000"),
  mayhemModeEnabled: false,
  whitelistedQuoteMints: [listed, usdc],
} as unknown as Global;
const quoteControl = {
  mints: [{ mint: controlled, initialVirtualQuoteReserves: new BN("9876543210") }],
} as QuoteControl;

function deploy(quoteMint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID, decimals = 6) {
  return {
    launchpad: "pump",
    mint, user: creator, creator,
    quoteAsset: { kind: "spl-token" as const, mint: quoteMint,
      tokenProgram, decimals },
    token: { mint: mint.publicKey.toBase58() },
    instructions: [], signers: [mint],
  } satisfies PreparedTokenDeployment;
}

test("Global quote seed takes precedence over QuoteControl when both list a mint", () => {
  const both = { ...quoteControl, mints: [
    ...quoteControl.mints,
    { mint: listed, initialVirtualQuoteReserves: new BN(10) },
  ] } as QuoteControl;
  expect(initialVirtualQuoteReservesFor(globalState, listed, both).toString())
    .toBe("321123456");
  const curve = newBondingCurve(globalState, listed, both);
  expect(curve.virtualQuoteReserves.toString()).toBe("321123456");
  expect(curve.virtualTokenReserves.toString()).toBe("1073000000000000");
  expect(curve.depth).toBe(0);
});

test("QuoteControl reserve is used in its own quote's native raw units", () => {
  const curve = newBondingCurve(globalState, controlled, quoteControl);
  expect(curve.virtualQuoteReserves.toString()).toBe("9876543210");
  expect(curve.virtualTokenReserves.eq(globalState.initialVirtualTokenReserves)).toBe(true);
  expect(curve.depth).toBe(0);
  expect(curve.quoteMint.equals(controlled)).toBe(true);
});

test("SOL initial seed keeps its legacy lamport units", () => {
  const native = newBondingCurve(globalState, SOL_ASSET.mint, quoteControl);
  expect(native.virtualQuoteReserves.toString()).toBe("30000000000");
  expect(native.quoteMint.equals(PublicKey.default)).toBe(true);
  expect(native.depth).toBe(0);
});

test("unlisted mint cannot borrow whitelisted reserve seed", () => {
  expect(() => newBondingCurve(globalState, unknown, quoteControl))
    .toThrow();
});

test("new curve cannot consume arbitrary quote reserves silently", () => {
  const initial = newBondingCurve(globalState, listed, quoteControl);
  const pending = {
    virtualBase: BigInt(initial.virtualTokenReserves.toString()),
    virtualQuote: BigInt(initial.virtualQuoteReserves.toString()),
  };
  expect(pending.virtualQuote).toBe(321123456n);
  expect(pending.virtualBase).toBeGreaterThan(0n);
  expect(pending.virtualQuote).not.toBe(BigInt(globalState.initialVirtualSolReserves.toString()));
});

test("Token-2022 quote is a distinct asset identity from SPL-token quote", () => {
  const legacy = deploy(controlled, TOKEN_PROGRAM_ID);
  const extended = deploy(controlled, TOKEN_2022_PROGRAM_ID);
  expect(legacy.quoteAsset.mint.equals(extended.quoteAsset.mint)).toBe(true);
  expect(legacy.quoteAsset.tokenProgram.equals(extended.quoteAsset.tokenProgram)).toBe(false);
  expect(extended.quoteAsset.decimals).toBe(6);
});

test("pending state rejects unsupported reserve state before building a creator buy", async () => {
  const plugin = new PumpTokenLaunchpad();
  await expect(plugin.buildPendingBuy({} as any, deploy(listed), creator,
    { asset: deploy(listed).quoteAsset, raw: 100n },
    { virtualBase: 0n, virtualQuote: 0n, totalFeeBps: 100 },
    { slippageBps: 500 },
  )).rejects.toThrow();
});


test("launchpad uses QuoteControl configuration for its pending creator buy", async () => {
  const resolve = spyOn(OnlinePumpSdk.prototype, "resolveQuoteMint").mockResolvedValue({
    mint: controlled, source: "quoteControl", quoteTokenProgram: TOKEN_PROGRAM_ID,
    decimals: 6, initialVirtualQuoteReserves: new BN("9876543210"),
  });
  const global = spyOn(OnlinePumpSdk.prototype, "fetchGlobal").mockResolvedValue(globalState);
  const control = spyOn(OnlinePumpSdk.prototype, "fetchQuoteControl").mockResolvedValue(quoteControl);
  try {
    const state = await new PumpTokenLaunchpad().initialPendingMarketState(
      {} as any, deploy(controlled),
    );
    expect(state.virtualQuote).toBe(9876543210n);
    expect(state.virtualBase).toBe(1073000000000000n);
    expect(control).toHaveBeenCalledTimes(1);
  } finally {
    resolve.mockRestore(); global.mockRestore(); control.mockRestore();
  }
});
