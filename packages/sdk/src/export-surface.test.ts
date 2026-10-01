import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
const client = readFileSync(join(import.meta.dir, "client.ts"), "utf8");
const protocol = readFileSync(join(import.meta.dir, "protocol.ts"), "utf8");

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
        "fetchTokenMetadata",
        "formatRaw",
        "publicTokenMetadataUrl",
        "subscribeLaunches",
        "subscribeMigrations",
        "subscribeTrades",
        "sol",
        "tokenAmount",
      ].sort(),
      types: [
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
        "SendReceipt",
        "SenderId",
        "SimulationResult",
        "TradeEvent",
        "TradeSide",
        "TradeSubscription",
        "TradeVenue",
        "Solard",
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

  test("does not create persistence at module import", () => {
    expect(source).not.toMatch(/createCoreSolard|createTraderSolard\(\)/);
    expect(client.indexOf("createCoreSolard(options)")).toBeGreaterThan(
      client.indexOf("export function createSolard"),
    );
  });

  test("does not expose core repositories or secret-bearing handles", () => {
    expect(client).not.toMatch(
      /\b(?:db|wallets|tokens|groups|executions|positions|prices|alts|senders|venues|claimSources|launches|launchpads|connection|signer)\s*:/,
    );
  });
});
