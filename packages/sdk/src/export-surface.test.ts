import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
const client = readFileSync(join(import.meta.dir, "client.ts"), "utf8");
const protocol = readFileSync(join(import.meta.dir, "protocol.ts"), "utf8");
const defaultClient = readFileSync(join(import.meta.dir, "default.ts"), "utf8");
const live = readFileSync(join(import.meta.dir, "live.ts"), "utf8");

function exportedNames(value: string) {
  const values: string[] = [];
  const types: string[] = [];
  const pattern = /export\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+["'][^"']+["'];/g;
  for (const match of value.matchAll(pattern)) {
    const target = match[1] ? types : values;
    for (const raw of match[2]!.split(",")) {
      const name =
        raw.trim().split(/\s+as\s+/)[1] ?? raw.trim().split(/\s+as\s+/)[0];
      if (name) target.push(name.trim());
    }
  }
  return {
    values: [...new Set(values)].sort(),
    types: [...new Set(types)].sort(),
  };
}

describe("sdk membrane", () => {
  test("has an exact curated root export surface", () => {
    expect(exportedNames(source)).toEqual({
      values: [
        "createSolard",
        "default",
        "fetchTokenMetadata",
        "formatRaw",
        "getSolUsdPrice",
        "isDefinitivePreSubmissionError",
        "publicTokenMetadataUrl",
        "subscribeLaunches",
        "subscribeMigrations",
        "listenTrades",
        "sol",
        "tokenAmount",
      ].sort(),
      types: [
        "TradeLandingPolicy",
        "ClaimCreatorRewardsOptions",
        "CreatorRewardClaimPayout",
        "CreatorRewardClaimResult",
        "CumulativeDistributionExecuteOptions",
        "CumulativeDistributionInput",
        "CumulativeDistributionPlan",
        "CumulativeDistributionRecipient",
        "CumulativeDistributionState",
        "CumulativeEntitlement",
        "FetchTokenMetadataOptions",
        "GetSolUsdPriceOptions",
        "HumanAmount",
        "LaunchEvent",
        "LaunchSubscription",
        "LaunchVenue",
        "MigrationDestination",
        "MigrationEvent",
        "MigrationSubscription",
        "MigrationVenue",
        "MarketHistory",
        "MarketHistoryOptions",
        "MarketPrice",
        "SolUsdPrice",
        "SolUsdSource",
        "SubscribeLaunchesOptions",
        "SubscribeMigrationsOptions",
        "ListenTradesOptions",
        "MergedReplayEventStream",
        "QuoteAsset",
        "ReplayCoverage",
        "ReplayEventSubscription",
        "ReplayEventsOptions",
        "ReplayHistory",
        "ReplayItem",
        "ReplayOptions",
        "ReplayPayout",
        "ReplayTransaction",
        "RecordConfirmedTradeInput",
        "SendReceipt",
        "SenderId",
        "SimulationResult",
        "SolardDecodedTransaction",
        "SolardPosition",
        "SolardPositionQuery",
        "SolardTransactionNativeBalance",
        "SolardTransactionOptions",
        "SolardTransactionTokenBalance",
        "SolardTrade",
        "SolardTradeQuery",
        "SolardTradeSide",
        "SolardTradeStatus",
        "TradeEvent",
        "TradeMarket",
        "TradeSide",
        "TradeListener",
        "TradeVenue",
        "Solard",
        "SolardBuyInput",
        "SolardSellInput",
        "SolardTradeExecutionOptions",
        "SolardTradeExecutionResult",
        "SolardCanonicalEvent",
        "SolardClaimAttribution",
        "SolardClaimEvent",
        "SolardEventsApi",
        "SolardHistoryApi",
        "SolardOptions",
        "ExcludedTokenHolder",
        "TokenHolder",
        "TokenHolderSnapshot",
        "TokenHolderSnapshotOptions",
        "TokenEventHistoryProgress",
        "TokenMetadata",
        "TokenMetadataHint",
        "TokenMetadataKind",
        "TokenMetadataMode",
        "TokenRef",
        "TokenRow",
        "WalletInfo",
        "WalletPrivateKeyExport",
        "WalletPrivateKeyFormat",
        "WalletRef",
      ].sort(),
    });
  });

  test("does not wildcard-export or deep-import core", () => {
    expect(source).not.toContain('export * from "@solard/core"');
    expect(source).not.toMatch(/\.\.\/\.\.\/core\/src|@solard\/core\//);
    expect(client).not.toMatch(/\.\.\/\.\.\/core\/src|@solard\/core\//);
  });

  test("keeps raw protocol decoders off the root surface", () => {
    expect(source).not.toMatch(
      /decode(?:ProgramDataLogs|PumpProgramData|PumpSwapProgramData|RaydiumLaunchLabProgramData)/,
    );
    expect(exportedNames(protocol)).toEqual({
      values: [
        "decodeProgramDataLogs",
        "decodePumpProgramData",
        "decodePumpSwapProgramData",
        "decodeRaydiumLaunchLabProgramData",
      ].sort(),
      types: [
        "PumpDecodedEvent",
        "PumpSwapDecodedEvent",
        "RaydiumLaunchLabDecodedEvent",
      ].sort(),
    });
  });

  test("exports a lazy zero-config default client", () => {
    expect(source).toContain('export { default } from "./default.ts"');
    expect(defaultClient).toContain("instance ??= createSolard()");
    expect(defaultClient).toContain('if (key === "close")');
    expect(defaultClient).toContain("getSolUsdPrice");
    expect(defaultClient).toContain("listenTrades");
    expect(defaultClient).toContain("subscribeLaunches");
    expect(defaultClient).toContain("subscribeMigrations");
    expect(defaultClient).not.toContain("export default createSolard()");
    expect(live).toContain("process.env.RPC_ENDPOINT");
    expect(live).not.toContain("SOLANA_RPC_URL");
    expect(live).not.toContain("HELIUS_RPC_URL");
    expect(live).not.toContain("SOLANA_WS_URL");
    expect(live).not.toContain("HELIUS_WS_URL");
  });

  test("does not create persistence at module import", () => {
    expect(source).not.toMatch(/createCoreSolard|createTraderSolard\(\)/);
    expect(defaultClient).not.toMatch(/^const\s+\w+\s*=\s*createSolard\(\)/m);
    expect(client.indexOf("createCoreSolard(options)")).toBeGreaterThan(
      client.indexOf("export function createSolard"),
    );
    expect(client).toContain(
      "recordConfirmedTrade: core.recordConfirmedTrade.bind(core)",
    );
    expect(client).toContain("trades: core.trades.bind(core)");
  });

  test("does not expose core repositories or secret-bearing handles", () => {
    expect(client).not.toMatch(
      /\b(?:db|wallets|tokens|groups|executions|positions|prices|alts|senders|venues|claimSources|launches|launchpads|connection|signer)\s*:/,
    );
  });
});
