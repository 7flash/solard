import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import { readMint } from "../chain/state.ts";
import { resolveTokenMintForPolicy } from "../chain/liquidation.ts";
import { createSolardMeasure } from "../core/log.ts";
import { tradeAssetLog, tradeRouteResolutionLog } from "../core/log-result.ts";
import { measured } from "../core/measured.ts";
import type { Solard } from "../core/solard.ts";
import type { TokenRow } from "../db/schema.ts";
import {
  nativePumpTradeAvailable,
  selectTradeRoute,
  type TradeRoute,
  type VenuePreference,
} from "./trade-route-policy.ts";

export {
  nativePumpTradeAvailable,
  selectTradeRoute,
} from "./trade-route-policy.ts";
export type { TradeRoute, VenuePreference } from "./trade-route-policy.ts";

export const NATIVE_SOL_MINT = NATIVE_MINT.toBase58();
export const CANONICAL_USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type TradeAsset = {
  ref: string;
  kind: "sol" | "token";
  symbol: string | null;
  mint: string;
  decimals: number;
  tokenProgram: string | null;
};

export type TradeRouteResolution = {
  route: TradeRoute;
  asset: TradeAsset;
  token: TokenRow | null;
};

const m = createSolardMeasure("trade-router");

function normalizedRef(value: string): string {
  return value.trim().replace(/^\$/, "");
}

async function resolveTradeAssetUnmeasured(
  slrd: Solard,
  input: string,
): Promise<TradeAsset> {
  const ref = normalizedRef(input);
  if (!ref) throw new Error("Asset reference is required");

  if (ref.toUpperCase() === "SOL") {
    return {
      ref: input,
      kind: "sol",
      symbol: "SOL",
      mint: NATIVE_SOL_MINT,
      decimals: 9,
      tokenProgram: null,
    };
  }

  const mint =
    ref.toUpperCase() === "USDC"
      ? CANONICAL_USDC_MINT
      : resolveTokenMintForPolicy(slrd, ref);

  const registered =
    slrd.tokens.list().find((row) => row.mint === mint) ?? null;

  // Avoid an RPC read only when the registered row already carries everything
  // needed for exact UI/raw conversion. Otherwise read the canonical mint state.
  if (registered?.decimals != null && registered.baseTokenProgram) {
    return {
      ref: input,
      kind: "token",
      symbol:
        ref.toUpperCase() === "USDC"
          ? "USDC"
          : (registered.symbol ?? registered.name ?? null),
      mint,
      decimals: registered.decimals,
      tokenProgram: registered.baseTokenProgram,
    };
  }

  // Canonical USDC is fixed Token Program + 6 decimals. Keeping this local fast
  // path means `slrd buy USDC` does not spend an RPC request merely to parse UI.
  if (mint === CANONICAL_USDC_MINT) {
    return {
      ref: input,
      kind: "token",
      symbol: "USDC",
      mint,
      decimals: 6,
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    };
  }

  const mintState = await readMint(
    slrd.connection(),
    new PublicKey(mint),
    slrd.cache,
  );

  return {
    ref: input,
    kind: "token",
    symbol: registered?.symbol ?? registered?.name ?? null,
    mint,
    decimals: mintState.decimals,
    tokenProgram: mintState.tokenProgram.toBase58(),
  };
}

export async function resolveTradeAsset(
  slrd: Solard,
  input: string,
): Promise<TradeAsset> {
  return await measured<TradeAsset, ReturnType<typeof tradeAssetLog>>(
    m,
    "asset",
    () => resolveTradeAssetUnmeasured(slrd, input),
    tradeAssetLog,
  );
}

export async function resolveTradeRoute(
  slrd: Solard,
  ref: string,
  preference: VenuePreference = "auto",
): Promise<TradeRouteResolution> {
  return await measured<
    TradeRouteResolution,
    ReturnType<typeof tradeRouteResolutionLog>
  >(
    m,
    "resolve",
    async () => {
      const asset = await resolveTradeAsset(slrd, ref);
      const token =
        asset.kind === "token"
          ? (slrd.tokens.list().find((row) => row.mint === asset.mint) ?? null)
          : null;

      return {
        asset,
        token,
        route: selectTradeRoute(token, preference),
      };
    },
    tradeRouteResolutionLog,
  );
}
