import { test, expect } from "bun:test";
import { Keypair, SystemProgram, type Connection } from "@solana/web3.js";
import { LaunchpadConfig, PlatformConfig, LAUNCHPAD_PROGRAM } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { TOKEN_2022_PROGRAM_ID, getMintLen, ExtensionType, AccountType, ACCOUNT_SIZE } from "@solana/spl-token";
import { SOL_ASSET, rawAmount } from "../../core/amounts.ts";
import { LaunchLabTokenLaunchpad, resolveLaunchLabPlatform, BONKFUN_PLATFORM_CONFIG, STONKFUN_PLATFORM_CONFIG } from "./launchlab-launchpad.ts";
function fixture() {
  const user = Keypair.generate().publicKey;
  const configId = Keypair.generate().publicKey; const platformId = Keypair.generate().publicKey;
  const configData = Buffer.alloc(LaunchpadConfig.span);
  SOL_ASSET.mint.toBuffer().copy(configData, LaunchpadConfig.offsetOf("mintB"));
  configData.writeBigUInt64LE(1000n, LaunchpadConfig.offsetOf("tradeFeeRate"));
  const platformData = Buffer.alloc(4096);
  platformData.writeBigUInt64LE(2000n, PlatformConfig.offsetOf("feeRate"));
  const mintData = Buffer.alloc(82); mintData[44] = 9; mintData[45] = 1;
  const info = (data: Buffer, owner = LAUNCHPAD_PROGRAM) => ({ data, owner, lamports: 1, executable: false, rentEpoch: 0 });
  const accounts = [info(configData), info(platformData), info(mintData, SOL_ASSET.tokenProgram)];
  const connection = { getMultipleAccountsInfo: async () => accounts } as unknown as Connection;
  let createArgs: any;
  const plugin = new LaunchLabTokenLaunchpad(async () => ({ launchpad: { createLaunchpad: async (args: any) => {
    createArgs = args;
    return { builder: { allInstructions: [SystemProgram.transfer({ fromPubkey: user, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }, extInfo: { address: {
      poolId: Keypair.generate().publicKey, mintA: args.mintA, mintB: args.configInfo.mintB, configId: args.configId, platformId: args.platformId,
      vaultA: Keypair.generate().publicKey, vaultB: Keypair.generate().publicKey,
      virtualA: new BN(1000000000), virtualB: new BN(1000000000), realA: new BN(0), realB: new BN(0), totalSellA: new BN(900000000), totalFundRaisingB: new BN(1000000000),
    } } };
  } } }));
  const args = { user, name: "Launch", symbol: "L", uri: "https://example.com/metadata.json", launchConfig: configId, platformConfig: platformId };
  return { plugin, connection, args, accounts, create: () => createArgs };
}
test("LaunchLab preparation uses verified platform/config and returns instructions, not an execution", async () => {
  const f = fixture(); const prepared = await f.plugin.prepareDeployment(f.connection, f.args);
  expect(f.create().createOnly).toBe(true);
  expect(f.create().platformId.equals(f.args.platformConfig)).toBe(true);
  expect(prepared.signers).toEqual([prepared.mint]);
  expect(prepared.metadata).toMatchObject({ protocolTradeFeeRate: "1000", platformTradeFeeRate: "2000", networkFeeLamports: null, costsRequireSimulation: true });
  expect(prepared.token.quoteMint).toBe(SOL_ASSET.mint.toBase58());
});
test("LaunchLab matching-quote creator buy is in the same SDK creation builder", async () => {
  const f = fixture(); await f.plugin.prepareDeployment(f.connection, { ...f.args, initialBuy: rawAmount(1000000n, SOL_ASSET), slippageBps: 500 });
  expect(f.create().createOnly).toBe(false);
  expect(f.create().buyAmount.toString()).toBe("1000000");
  expect(f.create().slippage.toString()).toBe("500");
});
test("LaunchLab rejects wrong owner and quote metadata before SDK construction", async () => {
  const f = fixture(); f.accounts[0]!.owner = SystemProgram.programId;
  await expect(f.plugin.prepareDeployment(f.connection, f.args)).rejects.toThrow("wrong program owner");
  expect(f.create()).toBeUndefined();
  f.accounts[0]!.owner = LAUNCHPAD_PROGRAM; f.accounts[2]!.data[44] = 6;
  await expect(f.plugin.prepareDeployment(f.connection, f.args)).rejects.toThrow("quote metadata");
  expect(f.create()).toBeUndefined();
});
test("verified platform names resolve explicitly and unknown aliases fail", () => {
  expect(resolveLaunchLabPlatform("bonkfun").equals(BONKFUN_PLATFORM_CONFIG)).toBe(true);
  expect(resolveLaunchLabPlatform("stonkfun").equals(STONKFUN_PLATFORM_CONFIG)).toBe(true);
  expect(() => resolveLaunchLabPlatform("constructor")).toThrow();
});
test("pending custom-quote buy creates missing ATAs and uses official curve fees/minimum", async () => {
  const f = fixture(); const mint = Keypair.generate().publicKey;
  mint.toBuffer().copy(f.accounts[0]!.data, LaunchpadConfig.offsetOf("mintB"));
  f.accounts[2]!.owner = TOKEN_2022_PROGRAM_ID;
  const data = Buffer.alloc(getMintLen([ExtensionType.TransferFeeConfig])); data[44] = 6; data[45] = 1; data[ACCOUNT_SIZE] = AccountType.Mint;
  data.writeUInt16LE(ExtensionType.TransferFeeConfig, 166); data.writeUInt16LE(108, 168);
  data.writeBigUInt64LE(1000000n, 170 + 80); data.writeUInt16LE(100, 170 + 88);
  data.writeBigUInt64LE(1000000n, 170 + 98); data.writeUInt16LE(100, 170 + 106);
  f.accounts[2]!.data = data;
  const quote = { kind: "spl-token" as const, mint, tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: 6 };
  const deployment = await f.plugin.prepareDeployment(f.connection, { ...f.args, quoteAsset: quote });
  f.connection.getSlot = async () => 100;
  const state = await f.plugin.initialPendingMarketState(f.connection, deployment);
  const buy = await f.plugin.buildPendingBuy(f.connection, deployment, f.args.user, rawAmount(1000000n, quote), state, { slippageBps: 500 });
  expect(buy.instructions).toHaveLength(3);
  expect(buy.instructions[2]!.data.readBigUInt64LE(8)).toBe(1000000n);
  expect(buy.instructions[2]!.data.readBigUInt64LE(16)).toBe(buy.minimumOutputRaw);
  expect(buy.minimumOutputRaw).toBe(buy.expectedOutputRaw * 9500n / 10000n);
  expect(buy.metadata!.quoteTradeFeeRaw).toBe("2970");
  expect(buy.metadata!.quoteTransferFeeRaw).toBe("10000");
  const next = await f.plugin.buildPendingBuy(f.connection, deployment, f.args.user, rawAmount(1000000n, quote), buy.nextState, { slippageBps: 500 });
  expect(next.expectedOutputRaw).toBeLessThan(buy.expectedOutputRaw);
});
